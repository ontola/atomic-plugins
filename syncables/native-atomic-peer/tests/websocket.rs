//! Real process and WebSocket boundary, using the unmodified Atomic WS client.
use atomic_lib::{
    agents::Agent,
    client::ws::{WsClient, WsMessage},
    sync::protocol,
};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use syncables_atomic_peer::{Projection, SourceResource, Status};

struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Process {
    fn start(
        dir: &std::path::Path,
        signer: &std::path::Path,
        owner: &Agent,
        reader: &Agent,
        port: u16,
    ) -> (Self, Status) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_syncables-atomic-peer"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut process = Self {
            child,
            input,
            output,
        };
        let status = process.request(serde_json::json!({"directory":dir,"signerFile":signer,
            "owner":owner.subject.to_string(),"collection":"invented/work/notes",
            "readers":[reader.subject.to_string()],"port":port}));
        (process, status)
    }
    fn request(&mut self, value: serde_json::Value) -> Status {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("No native status: {line}"))
    }
}
async fn message(rx: &mut tokio::sync::broadcast::Receiver<WsMessage>) -> WsMessage {
    tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap()
}
#[tokio::test(flavor = "multi_thread")]
async fn official_ws_client_authenticates_subscribes_reconnects_and_gets_refusals() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented owner")).unwrap();
    let reader = Agent::new(Some("Invented reader")).unwrap();
    let signer = dir.path().join("invented-secret");
    std::fs::write(&signer, owner.build_secret().unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&signer, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = socket.local_addr().unwrap().port();
    drop(socket);
    let store = dir.path().join("projection");
    let (mut process, initial) = Process::start(&store, &signer, &owner, &reader, port);
    let raw = r#"{"@id":"urn:invented:1","urn:invented:number":9007199254740993123.0001}"#;
    let mut projection = Projection {
        owner: owner.subject.to_string(),
        collection: "invented/work/notes".into(),
        scope: "invented".into(),
        revision: format!("{:064x}", 1),
        context: "{}".into(),
        resources: vec![SourceResource {
            subject: "urn:invented:1".into(),
            raw: raw.into(),
            hash: hex::encode(Sha256::digest(raw.as_bytes())),
            item: true,
            types: vec![],
        }],
    };
    let complete = process.request(serde_json::json!({"type":"project","projection":projection}));
    assert_eq!(complete.drive, initial.drive);
    process.request(serde_json::json!({"type":"listen"}));
    let client = WsClient::connect(&format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    let mut rx = client.subscribe();
    client.authenticate(&reader).await.unwrap();
    loop {
        if matches!(message(&mut rx).await, WsMessage::Authenticated) {
            break;
        }
    }
    assert!(client
        .server_capabilities()
        .contains(&"canonical-scheme".into()));
    assert!(!client.server_capabilities().contains(&"ephemeral".into()));
    client
        .send_binary(protocol::encode_get(10, &complete.drive))
        .await
        .unwrap();
    loop {
        if let WsMessage::Update {
            subject,
            loro_bytes,
            ..
        } = message(&mut rx).await
        {
            assert_eq!(subject, complete.drive);
            assert!(!loro_bytes.is_empty());
            break;
        }
    }
    client.subscribe_drive(&complete.drive).await.unwrap();
    // A GET barrier confirms SUB was processed before the next publication.
    client
        .send_binary(protocol::encode_get(11, &complete.drive))
        .await
        .unwrap();
    loop {
        if matches!(message(&mut rx).await, WsMessage::Update { .. }) {
            break;
        }
    }
    projection.revision = format!("{:064x}", 2);
    process.request(serde_json::json!({"type":"project","projection":projection}));
    loop {
        if let WsMessage::Update {
            subject, is_push, ..
        } = message(&mut rx).await
        {
            assert_eq!(subject, complete.drive);
            assert!(is_push);
            break;
        }
    }
    client
        .send_binary(protocol::encode_commit(9, "{}"))
        .await
        .unwrap();
    loop {
        if let WsMessage::Error {
            code, request_id, ..
        } = message(&mut rx).await
        {
            assert_eq!(code, protocol::error_code::UNAUTHORIZED_WRITE);
            assert_eq!(request_id, 9);
            break;
        }
    }
    // Kill without a graceful close. The acknowledged checkpoint and drive survive.
    drop(process);
    let (mut process, recovered) = Process::start(&store, &signer, &owner, &reader, port);
    assert_eq!(recovered.drive, complete.drive);
    assert_eq!(
        recovered.revision.as_deref(),
        Some(projection.revision.as_str())
    );
    process.request(serde_json::json!({"type":"project","projection":projection}));
    process.request(serde_json::json!({"type":"listen"}));
    let client = WsClient::connect(&format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    let mut rx = client.subscribe();
    client.authenticate(&reader).await.unwrap();
    loop {
        if matches!(message(&mut rx).await, WsMessage::Authenticated) {
            break;
        }
    }
    client
        .send_binary(protocol::encode_get(12, &complete.drive))
        .await
        .unwrap();
    loop {
        if let WsMessage::Update { subject, .. } = message(&mut rx).await {
            assert_eq!(subject, complete.drive);
            break;
        }
    }
}
