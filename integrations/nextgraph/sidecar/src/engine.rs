//! The NextGraph side: an operator-held wallet, a local verifier that saves
//! to disk, and (optionally) a connection to the wallet's broker.
//!
//! Data-exposure model: the verifier decrypts documents *in this process*, on
//! the operator's machine, with keys from the operator's wallet. Everything
//! this sidecar returns to Atomic Server is plaintext RDF. NextGraph's
//! end-to-end encryption still protects the data on brokers and in transit
//! between them, but for the documents this wallet can open, the operator's
//! host is an endpoint of that encryption, as NextGraph's own headless mode
//! is. See the plugin README, "Data exposure".
use crate::service::{Engine, SELECT};
use nextgraph::local_broker::{
    app_request, doc_create, doc_sparql_update, init_local_broker, session_start, user_connect,
    wallet_create_v0, wallet_get, wallet_open_with_mnemonic_words, wallet_was_opened,
    LocalBrokerConfig, SessionConfig,
};
use nextgraph::net::app_protocol::{
    AppRequest, AppRequestCommandV0, AppRequestPayload, AppRequestV0, AppResponse, AppResponseV0,
    NuriV0,
};
use nextgraph::net::types::BootstrapContentV0;
use nextgraph::repo::types::PubKey;
use nextgraph::wallet::types::CreateWalletV0;
use ng_oxigraph::spargebra::{term::GraphName, GraphUpdateOperation, Update};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// What `init` stores for `serve`: readable by the operator's account only.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub wallet_name: String,
    pub mnemonic: Vec<String>,
    pub pin: [u8; 4],
}

pub struct NextGraph {
    session_id: u64,
    broker: String,
}

fn ng_dir(base: &Path) -> PathBuf {
    base.join("ng")
}

pub fn credentials_path(base: &Path) -> PathBuf {
    base.join("credentials.json")
}

async fn start_broker(base: &Path) -> Result<(), String> {
    let dir = ng_dir(base);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    init_local_broker(Box::new(move || LocalBrokerConfig::BasePath(dir.clone()))).await;
    Ok(())
}

/// A PIN NextGraph accepts: four different digits, not a run like 1234.
fn random_pin() -> Result<[u8; 4], String> {
    use std::io::Read;
    let mut random = std::fs::File::open("/dev/urandom").map_err(|e| e.to_string())?;
    loop {
        let mut bytes = [0u8; 4];
        random.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        let pin = bytes.map(|b| b % 10);
        let distinct = (0..4).all(|i| (i + 1..4).all(|j| pin[i] != pin[j]));
        let step = |d: i16| (0..3).all(|i| pin[i + 1] as i16 - pin[i] as i16 == d);
        if distinct && !step(1) && !step(-1) {
            return Ok(pin);
        }
    }
}

/// Creates a wallet saved under `base`, and `documents` Graph documents in its
/// private store; `seed`, when given, is a SPARQL update applied to the first.
/// Returns the documents' NURIs. The wallet's mnemonic and PIN go to
/// `credentials.json` (mode 0600), never to stdout.
pub async fn init(
    base: &Path,
    broker_peer: Option<PubKey>,
    documents: usize,
    seed: Option<String>,
) -> Result<Vec<String>, String> {
    let credentials = credentials_path(base);
    if credentials.exists() {
        return Err(format!("{} already exists", credentials.display()));
    }
    start_broker(base).await?;
    let pin = random_pin()?;
    let created = wallet_create_v0(CreateWalletV0 {
        security_img: None,
        security_txt: "Atomic Server NextGraph sidecar".into(),
        pin: Some(pin),
        pazzle_length: 0,
        password: None,
        mnemonic: true,
        send_bootstrap: false,
        send_wallet: false,
        result_with_wallet_file: false,
        local_save: true,
        // Without a broker the wallet is local-only: it cannot sync, but its
        // documents are real NextGraph repositories, saved by the verifier.
        #[allow(deprecated)]
        core_bootstrap: BootstrapContentV0::new_localhost(broker_peer.unwrap_or(PubKey::nil())),
        core_registration: None,
        additional_bootstrap: None,
        pdf: false,
        device_name: "atomic-sidecar".into(),
    })
    .await
    .map_err(|e| format!("wallet_create_v0: {e}"))?;
    let mut created_documents = Vec::new();
    for _ in 0..documents.max(1) {
        created_documents.push(
            doc_create(
                created.session_id,
                "Graph".into(),
                "data:graph".into(),
                "store".into(),
                None,
                None,
            )
            .await
            .map_err(|e| format!("doc_create: {e}"))?,
        );
    }
    if let Some(seed) = seed {
        doc_sparql_update(created.session_id, seed, Some(created_documents[0].clone()))
            .await
            .map_err(|e| format!("seed: {e}"))?;
    }
    let secret = Credentials {
        wallet_name: created.wallet_name.clone(),
        mnemonic: created.mnemonic_str.clone(),
        pin,
    };
    write_private(
        &credentials,
        &serde_json::to_vec(&secret).map_err(|e| e.to_string())?,
    )?;
    Ok(created_documents)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

impl NextGraph {
    /// Opens the wallet `init` saved and starts a session whose verifier saves
    /// to disk. With `connect`, also connects to the wallet's broker.
    pub async fn open(base: &Path, connect: bool) -> Result<Self, String> {
        let raw = std::fs::read(credentials_path(base)).map_err(|e| {
            format!(
                "{}: {e} (run `init` first)",
                credentials_path(base).display()
            )
        })?;
        let secret: Credentials = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        start_broker(base).await?;
        let wallet = wallet_get(&secret.wallet_name)
            .await
            .map_err(|e| format!("wallet_get: {e}"))?;
        let opened = wallet_open_with_mnemonic_words(&wallet, &secret.mnemonic, secret.pin)
            .map_err(|e| format!("wallet_open: {e}"))?;
        let user = opened.personal_identity();
        wallet_was_opened(opened)
            .await
            .map_err(|e| format!("wallet_was_opened: {e}"))?;
        let session = session_start(SessionConfig::new_save(&user, &secret.wallet_name))
            .await
            .map_err(|e| format!("session_start: {e}"))?;
        let broker = if connect {
            match user_connect(&user).await {
                Ok(status) => status
                    .iter()
                    .map(|(server, _, _, error, _)| match error {
                        None => format!("connected to {server}"),
                        Some(e) => format!("{server}: {e}"),
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
                Err(e) => format!("not connected: {e}"),
            }
        } else {
            "offline (not asked to connect)".into()
        };
        Ok(Self {
            session_id: session.session_id,
            broker,
        })
    }
}

impl Engine for NextGraph {
    fn check_document(&self, document: &str) -> Result<(), String> {
        if !document.starts_with("did:ng:o:") || document.len() > 512 {
            return Err("document must be a NextGraph document NURI (did:ng:o:...)".into());
        }
        NuriV0::new_from(&document.to_string())
            .map(|_| ())
            .map_err(|e| format!("not a NextGraph NURI: {e}"))
    }

    fn check_insert_only(&self, update: &str) -> Result<(), String> {
        let parsed = Update::parse(update, None).map_err(|e| e.to_string())?;
        if parsed.operations.is_empty() {
            return Err("empty update".into());
        }
        for operation in &parsed.operations {
            let GraphUpdateOperation::InsertData { data } = operation else {
                return Err("only INSERT DATA is accepted".into());
            };
            if data.iter().any(|q| q.graph_name != GraphName::DefaultGraph) {
                return Err("INSERT DATA may not name a graph".into());
            }
        }
        Ok(())
    }

    fn query(&mut self, document: &str) -> Result<String, String> {
        async_std::task::block_on(async {
            let nuri = NuriV0::new_from(&document.to_string()).map_err(|e| e.to_string())?;
            let base = nuri.repo();
            let request = AppRequest::V0(AppRequestV0 {
                command: AppRequestCommandV0::new_read_query(),
                nuri,
                payload: Some(AppRequestPayload::new_sparql_query(
                    SELECT.into(),
                    Some(base),
                )),
                session_id: self.session_id,
            });
            match app_request(request).await.map_err(|e| e.to_string())? {
                AppResponse::V0(AppResponseV0::QueryResult(bytes)) => {
                    String::from_utf8(bytes).map_err(|e| e.to_string())
                }
                AppResponse::V0(AppResponseV0::Error(e)) => Err(e),
                _ => Err("unexpected NextGraph response to a SELECT".into()),
            }
        })
    }

    fn update(&mut self, document: &str, update: &str) -> Result<Vec<String>, String> {
        async_std::task::block_on(doc_sparql_update(
            self.session_id,
            update.to_string(),
            Some(document.to_string()),
        ))
    }

    fn broker_status(&self) -> String {
        self.broker.clone()
    }
}
