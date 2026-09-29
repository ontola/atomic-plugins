//! ng-atomic-sidecar: the operator-run NextGraph boundary for the Atomic
//! Server `nextgraph` plugin. See ../README.md, "Live sidecar".
//!
//!   ng-atomic-sidecar init  --base DIR [--documents N] [--seed FILE] [--broker-peer PEER_ID]
//!   ng-atomic-sidecar serve --base DIR --listen 127.0.0.1:PORT [--connect]
//!
//! `init` creates a NextGraph wallet saved under DIR and N Graph documents
//! (default 1), applies the SPARQL update in FILE to the first, and prints
//! `{"documents": [NURI, ...]}`. `serve` opens that wallet and answers the
//! scoped operations in service.rs. Scopes are read from DIR/scopes.json on
//! every request; acknowledgements are kept in DIR/acks.json.
mod engine;
mod service;

use service::{Request, Service, MAX_BODY_BYTES};
use std::io::Read;
use std::path::PathBuf;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(String::as_str) {
        Some("init") => init(&args),
        Some("serve") => serve(&args),
        _ => Err("usage: ng-atomic-sidecar init|serve --base DIR [...]".into()),
    };
    if let Err(e) = result {
        eprintln!("ng-atomic-sidecar: {e}");
        std::process::exit(1);
    }
}

fn base(args: &[String]) -> Result<PathBuf, String> {
    let base = PathBuf::from(arg(args, "--base").ok_or("--base DIR is required")?);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base)
}

fn init(args: &[String]) -> Result<(), String> {
    let base = base(args)?;
    let peer = match arg(args, "--broker-peer") {
        Some(raw) => Some(
            raw.as_str()
                .try_into()
                .map_err(|e| format!("--broker-peer: {e:?}"))?,
        ),
        None => None,
    };
    let documents = match arg(args, "--documents") {
        Some(n) => n
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=16).contains(n))
            .ok_or("--documents must be 1 to 16")?,
        None => 1,
    };
    let seed = arg(args, "--seed")
        .map(|path| std::fs::read_to_string(&path).map_err(|e| format!("--seed {path}: {e}")))
        .transpose()?;
    let documents = async_std::task::block_on(engine::init(&base, peer, documents, seed))?;
    println!("{}", serde_json::json!({ "documents": documents }));
    Ok(())
}

fn serve(args: &[String]) -> Result<(), String> {
    let base = base(args)?;
    let listen = arg(args, "--listen").unwrap_or_else(|| "127.0.0.1:14480".into());
    let connect = args.iter().any(|a| a == "--connect");
    let engine = async_std::task::block_on(engine::NextGraph::open(&base, connect))?;
    let mut service = Service {
        engine,
        scopes: base.join("scopes.json"),
        acks: base.join("acks.json"),
        now: now_ms,
    };
    let server = tiny_http::Server::http(&listen).map_err(|e| e.to_string())?;
    eprintln!("ng-atomic-sidecar: listening on {listen}");
    // One request at a time: the NextGraph session and the ack store are
    // both single-writer, and this is a loopback control plane, not a
    // throughput path.
    for mut incoming in server.incoming_requests() {
        let installation = incoming
            .headers()
            .iter()
            .find(|h| h.field.equiv("x-atomic-installation"))
            .map(|h| h.value.as_str().to_string());
        let mut body = Vec::new();
        let read = incoming
            .as_reader()
            .take(MAX_BODY_BYTES as u64 + 1)
            .read_to_end(&mut body);
        let response = match read {
            Ok(_) => service.handle(Request {
                method: incoming.method().as_str().to_ascii_uppercase(),
                path: incoming.url().split('?').next().unwrap_or("").to_string(),
                installation,
                body,
            }),
            Err(e) => service::Response {
                status: 400,
                content_type: "text/plain",
                body: e.to_string(),
            },
        };
        let header =
            tiny_http::Header::from_bytes(&b"Content-Type"[..], response.content_type.as_bytes())
                .expect("static header");
        let _ = incoming.respond(
            tiny_http::Response::from_string(response.body)
                .with_status_code(response.status)
                .with_header(header),
        );
    }
    Ok(())
}
