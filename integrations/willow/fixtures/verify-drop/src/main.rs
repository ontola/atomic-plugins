//! Decodes each drop file named on the command line with willow25 0.7.9's
//! `DropDecoder`, which verifies every entry's authorisation token (the
//! Meadowcap capability and the Ed25519 signature over `encode_entry`), and
//! prints one JSON line per entry. Exits non-zero on the first refusal.
//!
//!     cargo run --release -- ../exported.drop
//!
//! `willow25UnixMillis` is willow25's own reading of the timestamp (through
//! hifitime), printed so its distance from the data model's reading shows.
use std::fmt::Write as _;
use ufotofu::codec_prelude::*;
use willow25::drop_format::*;
use willow25::prelude::*;

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(out, "{b:02x}").unwrap();
    }
    out
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: willow-verify-drop <file.drop>...");
        std::process::exit(2);
    }
    for file in files {
        let bytes = std::fs::read(&file).expect("readable drop file");
        let count = pollster::block_on(async {
            let mut decoder = DropDecoder::new(bytes.into_producer());
            let mut count = 0usize;
            loop {
                match decoder.produce().await {
                    Ok(Left((metadata, mut slice))) => {
                        let mut payload = Vec::new();
                        while let Left(byte) = slice.produce().await.expect("slice bytes") {
                            payload.push(byte);
                        }
                        let e = metadata.entry().entry();
                        let components: Vec<String> = e
                            .path()
                            .components()
                            .map(|c| format!("\"{}\"", hex(c.as_ref())))
                            .collect();
                        println!(
                            "{{\"file\": \"{file}\", \"entry\": {count}, \"namespace\": \"{}\", \"subspace\": \"{}\", \"path\": [{}], \"timestamp\": \"{}\", \"willow25UnixMillis\": \"{}\", \"payloadLength\": \"{}\", \"payloadDigest\": \"{}\", \"payload\": \"{}\"}}",
                            hex(e.namespace_id().as_bytes()),
                            hex(e.subspace_id().as_bytes()),
                            components.join(", "),
                            u64::from(e.timestamp()),
                            Epoch::from(e.timestamp()).to_unix_milliseconds() as i64,
                            e.payload_length(),
                            hex(e.payload_digest().as_bytes()),
                            hex(&payload),
                        );
                        count += 1;
                    }
                    Ok(Right(())) => break,
                    Err(error) => {
                        eprintln!("{file}: entry {count} refused: {error:?}");
                        std::process::exit(1);
                    }
                }
            }
            count
        });
        eprintln!("{file}: willow25 DropDecoder accepted {count} entries");
    }
}
