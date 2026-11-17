use atomic_lib::{
    agents::{self, Agent},
    errors::AtomicResult,
    sync::protocol,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use syncables_atomic_peer::{Peer, Projection, Session, MAX_BYTES};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    sync::{broadcast, RwLock, Semaphore},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Init {
    directory: PathBuf,
    signer_file: PathBuf,
    owner: String,
    collection: String,
    readers: Vec<String>,
    port: u16,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Command {
    Project {
        projection: Projection,
    },
    ProjectTables {
        projection: syncables_atomic_peer::tables::NativeProjection,
    },
    Listen,
}

async fn line(reader: &mut (impl AsyncBufRead + Unpin)) -> AtomicResult<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if result.is_empty() {
                Ok(None)
            } else {
                Err("Truncated control message".into())
            };
        }
        let end = available.iter().position(|&b| b == b'\n');
        let size = end.map_or(available.len(), |i| i + 1);
        if result.len() + size > MAX_BYTES {
            return Err("Control message too large".into());
        }
        result.extend_from_slice(&available[..size]);
        reader.consume(size);
        if end.is_some() {
            return Ok(Some(result));
        }
    }
}
fn private_file(path: &Path) -> AtomicResult<String> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 32_768 {
        return Err("Invalid signer file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Signer file must be private (0600)".into());
        }
    }
    Ok(std::fs::read_to_string(path)?.trim().to_owned())
}
async fn connect(
    stream: TcpStream,
    peer: Arc<RwLock<Peer>>,
    origin: String,
    mut publications: broadcast::Receiver<Vec<String>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BYTES))
        .max_frame_size(Some(MAX_BYTES));
    let mut socket = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        accept_async_with_config(stream, Some(config)),
    )
    .await??;
    let mut session = Session::new(origin);
    socket
        .send(Message::Binary(
            protocol::encode_challenge(&session.nonce).into(),
        ))
        .await?;
    loop {
        let frames = tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    let peer = peer.read().await;
                    session.handle(&peer, &bytes).await
                },
                Some(Ok(Message::Ping(bytes))) => { socket.send(Message::Pong(bytes)).await?; continue; },
                Some(Ok(Message::Pong(_))) => continue,
                _ => return Ok(()),
            },
            changed = publications.recv() => {
                // Lagging peers reconnect and reconcile from their persisted VVs.
                let changed = changed.map_err(|_| "Publication stream lagged or closed")?;
                let peer = peer.read().await;
                session.updates(&peer, &changed).await
            },
        };
        for frame in frames {
            tokio::time::timeout(
                std::time::Duration::from_secs(30),
                socket.send(Message::Binary(frame.into())),
            )
            .await??;
        }
    }
}
async fn reply(peer: &Peer) -> AtomicResult<()> {
    let mut bytes = serde_json::to_vec(&peer.status().await?)?;
    bytes.push(b'\n');
    tokio::io::stdout().write_all(&bytes).await?;
    Ok(())
}
async fn run() -> AtomicResult<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let init: Init =
        serde_json::from_slice(&line(&mut input).await?.ok_or("Missing initialization")?)?;
    if !init.directory.is_absolute() || !init.signer_file.is_absolute() {
        return Err("Use absolute directory and signer file paths".into());
    }
    if !init.directory.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&init.directory)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir_all(&init.directory)?;
    }
    let metadata = std::fs::symlink_metadata(&init.directory)?;
    if !metadata.is_dir() {
        return Err("Invalid projection directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Projection directory must be private (0700)".into());
        }
    }
    let secret = private_file(&init.signer_file)?;
    // Validate before Agent::from_secret: the core assumes a valid private seed.
    let decoded: serde_json::Value = serde_json::from_slice(&agents::decode_base64(&secret)?)?;
    let private = decoded
        .get("privateKey")
        .and_then(|v| v.as_str())
        .ok_or("Invalid signer secret")?;
    if agents::decode_base64(private)?.len() != 32 {
        return Err("Invalid signer seed".into());
    }
    let signer = Agent::from_secret(&secret)?;
    let derived = Agent::new_from_public_key(&signer.public_key)?;
    if derived.subject.pure_id() != signer.subject.pure_id() {
        return Err("Signer identity mismatch".into());
    }
    let peer = Peer::open(
        &init.directory,
        signer,
        &init.owner,
        &init.collection,
        &init.readers,
    )
    .await?;
    reply(&peer).await?;
    let peer = Arc::new(RwLock::new(peer));
    let (publications, _) = broadcast::channel::<Vec<String>>(32);
    let mut listening = false;
    let connections = Arc::new(Semaphore::new(32));
    while let Some(bytes) = line(&mut input).await? {
        match serde_json::from_slice::<Command>(&bytes)? {
            Command::Project { projection } => {
                let peer = peer.write().await;
                let changed = peer.project(&projection).await?;
                reply(&peer).await?; // Durable checkpoint before acknowledgement.
                if !changed.is_empty() {
                    let _ = publications.send(changed);
                }
            }
            Command::ProjectTables { projection } => {
                let peer = peer.write().await;
                let changed = peer.project_tables(&projection).await?;
                reply(&peer).await?;
                if !changed.is_empty() {
                    let _ = publications.send(changed);
                }
            }
            Command::Listen => {
                if listening {
                    return Err("Already listening".into());
                }
                if peer.read().await.status().await?.revision.is_none() {
                    return Err("Publish a source revision before listening".into());
                }
                let listener =
                    TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, init.port)).await?;
                let origin = format!("http://{}", listener.local_addr()?);
                let listener_peer = peer.clone();
                let publications = publications.clone();
                let connections = connections.clone();
                tokio::spawn(async move {
                    while let Ok((stream, _)) = listener.accept().await {
                        let Ok(permit) = connections.clone().try_acquire_owned() else {
                            continue;
                        };
                        let peer = listener_peer.clone();
                        let origin = origin.clone();
                        let receiver = publications.subscribe();
                        tokio::spawn(async move {
                            let _permit = permit;
                            let _ = connect(stream, peer, origin, receiver).await;
                        });
                    }
                });
                listening = true;
                reply(&*peer.read().await).await?;
            }
        }
    }
    peer.read().await.db.flush()?;
    Ok(())
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        // Core validation errors may quote source values. Keep all source data,
        // credentials and private key material out of stderr.
        eprintln!("syncables-atomic-peer: initialization or projection failed; no completion acknowledged for the failed operation");
        std::process::exit(1);
    }
}
