use std::{pin::Pin, sync::Arc, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use tokio::sync::RwLock;
use tokio_postgres::Client;

pub(crate) type ConnectionDriver =
    Pin<Box<dyn std::future::Future<Output = Result<(), tokio_postgres::Error>> + Send>>;

pub(crate) async fn connect_once(database_url: &str) -> Result<(Client, ConnectionDriver), String> {
    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let tls = postgres_native_tls::MakeTlsConnector::new(tls);
    let (client, connection) = tokio_postgres::connect(database_url, tls)
        .await
        .map_err(|e| e.to_string())?;
    Ok((client, Box::pin(connection)))
}

/// Drives the active connection to completion, then keeps reconnecting with
/// exponential backoff and swapping the shared client in on success, so a
/// dropped connection recovers without restarting the process.
fn spawn_reconnect_supervisor(
    database_url: String,
    current: Arc<RwLock<Arc<Client>>>,
    mut connection: ConnectionDriver,
) {
    tokio::spawn(async move {
        loop {
            if let Err(error) = connection.await {
                tracing::error!(%error, "postgres connection failed; reconnecting");
            } else {
                tracing::warn!("postgres connection closed; reconnecting");
            }
            let mut backoff = Duration::from_secs(1);
            loop {
                match connect_once(&database_url).await {
                    Ok((client, new_connection)) => {
                        *current.write().await = Arc::new(client);
                        connection = new_connection;
                        break;
                    }
                    Err(error) => {
                        tracing::error!(%error, ?backoff, "postgres reconnect attempt failed; retrying");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                }
            }
        }
    });
}

/// Days a connection survives without an authenticated request (decision 5).
/// Measured from `last_used_at`, which is bumped only after a request has
/// authenticated, so knowing a connection id is not enough to keep one alive.
pub const CONNECTION_IDLE_DAYS: i32 = 90;

/// How long one caller may hold a connection's refresh lease before another
/// may take it over. Longer than a provider token request should take, short
/// enough that a crashed holder does not wedge the connection.
const REFRESH_LEASE_SECONDS: f64 = 30.0;

/// Schema, created idempotently at startup. The tables of the tenant era
/// (`oauth_states`, `connection_codes`) are no longer read or written; they
/// are left in place rather than dropped, see the README's flag-day notes.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS used_challenges_expires_at_idx ON used_challenges (expires_at);
CREATE TABLE IF NOT EXISTS connection_handoffs (code TEXT PRIMARY KEY, challenge TEXT NOT NULL, envelope TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS connection_handoffs_expires_at_idx ON connection_handoffs (expires_at);
CREATE TABLE IF NOT EXISTS connect_states (state TEXT PRIMARY KEY, platform TEXT NOT NULL, verifier TEXT NOT NULL, context TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS connect_states_expires_at_idx ON connect_states (expires_at);
CREATE TABLE IF NOT EXISTS agent_connections (
  connection_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  owner TEXT NOT NULL,
  envelope TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  refresh_lease_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_connections_owner_idx ON agent_connections (owner);
CREATE INDEX IF NOT EXISTS agent_connections_last_used_at_idx ON agent_connections (last_used_at);
ALTER TABLE agent_connections ADD COLUMN IF NOT EXISTS label_envelope TEXT;
CREATE TABLE IF NOT EXISTS connection_delegations (
  connection_id TEXT NOT NULL REFERENCES agent_connections (connection_id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (connection_id, agent)
);
CREATE TABLE IF NOT EXISTS app_runtimes (
  owner TEXT NOT NULL,
  agent TEXT NOT NULL,
  app TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  PRIMARY KEY (owner, agent)
);
CREATE INDEX IF NOT EXISTS app_runtimes_app_idx ON app_runtimes (owner, app);
CREATE TABLE IF NOT EXISTS key_check_limits (
  bucket TEXT NOT NULL,
  slot INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bucket, slot)
);
CREATE INDEX IF NOT EXISTS key_check_limits_expires_at_idx ON key_check_limits (expires_at);
CREATE TABLE IF NOT EXISTS retired_agents (
  agent TEXT PRIMARY KEY,
  successor TEXT NOT NULL,
  retired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
";

/// Why [`Security::transfer_owner`] moved nothing.
#[derive(Debug)]
pub enum TransferError {
    /// The old or the new id is already retired.
    Retired,
    /// The old id has webhook subscriptions that are not closed.
    Blocked,
    /// The move would collide with something the new id already holds (a
    /// runtime with the same agent); the whole statement was undone.
    Conflict,
    Database(String),
}

/// What a transfer moved.
pub struct Transferred {
    pub connections: i64,
    pub runtimes: i64,
}

/// A pending provider authorization, from `/connect/authorize` to the
/// provider's callback.
pub struct ConnectState {
    pub platform: String,
    /// The PKCE verifier for the provider (not the hub's).
    pub verifier: String,
    /// Sealed `connect::OAuthContext`.
    pub context: String,
}

/// A connection row, with its credential opened.
pub struct ConnectionRecord {
    pub connection_id: String,
    pub platform: String,
    /// Canonical `atomic:agent:` id.
    pub owner: String,
    /// The serialized `StoredCredential`; interpreted by `proxy.rs`.
    pub credential: Vec<u8>,
}

/// How the signer of a request is related to a connection.
#[derive(Debug, PartialEq, Eq)]
pub enum Standing {
    Owner,
    /// The signer holds a delegation itself (an installation's app agent).
    Delegate,
    /// The signer is a registered runtime of `app`, which holds a delegation.
    Runtime {
        app: String,
    },
    None,
}

#[derive(serde::Serialize)]
pub struct DelegationInfo {
    pub agent: String,
    pub label: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(serde::Serialize)]
pub struct RuntimeInfo {
    pub agent: String,
    pub app: String,
    pub label: Option<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(serde::Serialize)]
pub struct ConnectionInfo {
    pub connection_id: String,
    pub platform: String,
    pub owner: String,
    /// What the provider's key check called the account
    /// (`x-api-key-details.keyCheck.label`); absent when none was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: String,
    pub last_used_at: String,
    pub delegations: Vec<DelegationInfo>,
}

fn connection_aad(connection_id: &str) -> Vec<u8> {
    // Bound to the row, so one row's envelope cannot be pasted into another.
    format!("agent-connection-v1:{connection_id}").into_bytes()
}

fn connection_label_aad(connection_id: &str) -> Vec<u8> {
    format!("agent-connection-label-v1:{connection_id}").into_bytes()
}

fn timestamp(value: std::time::SystemTime) -> String {
    time::OffsetDateTime::from(value)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn db_error(error: tokio_postgres::Error) -> String {
    error.to_string()
}

#[derive(Clone)]
pub struct Security {
    database: Arc<RwLock<Arc<Client>>>,
    /// Dedicated connections for the owner writes that must not race a key
    /// transfer (#410): each runs in a transaction holding the owners'
    /// advisory locks ([`lock_owners`]).
    owner_writes: Arc<crate::webhooks::pool::Pool>,
    encryption_key: [u8; 32],
    /// `HMAC-SHA256(ENCRYPTION_KEY, KEY_CHECK_SUBKEY_LABEL)`: the key of the
    /// key-check buckets, so the encryption key itself is used only by
    /// XChaCha20-Poly1305.
    key_check_key: [u8; 32],
    /// `HMAC-SHA256(ENCRYPTION_KEY, IDEMPOTENCY_SUBKEY_LABEL)`, the key of
    /// [`Security::connection_idempotency_key`], derived once.
    idempotency_key: [u8; 32],
}

const KEY_CHECK_SUBKEY_LABEL: &[u8] = b"integration-proxy-key-check-limit-v1";

/// The error text of an owner write refused because the owner was retired
/// by a key transfer; callers answer `agent_retired`.
pub const OWNER_RETIRED: &str = "owner retired";

/// Takes the transaction-scoped advisory lock of each owner, in sorted
/// order so two transactions locking the same pair cannot deadlock. Every
/// write that creates or changes what an owner holds (a connection, a
/// runtime, a delegation) and every transfer take these locks first, so a
/// transfer and such a write never interleave: the write either commits
/// before the transfer moves things, or sees the owner retired.
async fn lock_owners(tx: &tokio_postgres::Transaction<'_>, owners: &[&str]) -> Result<(), String> {
    let mut owners = owners.to_vec();
    owners.sort_unstable();
    owners.dedup();
    for owner in owners {
        tx.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&owner],
        )
        .await
        .map_err(db_error)?;
    }
    Ok(())
}

async fn retired_in(tx: &tokio_postgres::Transaction<'_>, agents: &[&str]) -> Result<bool, String> {
    let agents: Vec<String> = agents.iter().map(|agent| agent.to_string()).collect();
    tx.query_one(
        "SELECT EXISTS (SELECT 1 FROM retired_agents WHERE agent = ANY($1))",
        &[&agents],
    )
    .await
    .map(|row| row.get(0))
    .map_err(db_error)
}
const IDEMPOTENCY_SUBKEY_LABEL: &[u8] = b"integration-proxy-idempotency-key-v1";

fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    use hmac::{Hmac, Mac};
    let mut mac =
        <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

impl Security {
    pub async fn connect(database_url: &str, encryption_key: &str) -> Result<Self, String> {
        let key = URL_SAFE_NO_PAD
            .decode(encryption_key)
            .map_err(|_| "ENCRYPTION_KEY must be base64url")?;
        let encryption_key: [u8; 32] = key
            .try_into()
            .map_err(|_| "ENCRYPTION_KEY must decode to exactly 32 bytes")?;
        // Schema setup needs a transaction, which requires exclusive (&mut)
        // access to a Client — incompatible with the shared, reconnectable
        // client below. Run it on its own short-lived connection first.
        {
            let (mut setup, setup_connection) = connect_once(database_url).await?;
            let driver = tokio::spawn(setup_connection);
            let transaction = setup.transaction().await.map_err(db_error)?;
            transaction
                .query_one(
                    "SELECT pg_advisory_xact_lock($1)",
                    &[&7_316_186_474_691_124_077_i64],
                )
                .await
                .map_err(db_error)?;
            transaction.batch_execute(SCHEMA).await.map_err(db_error)?;
            transaction.commit().await.map_err(db_error)?;
            drop(setup);
            let _ = driver.await;
        }

        let (client, connection) = connect_once(database_url).await?;
        let database = Arc::new(RwLock::new(Arc::new(client)));
        spawn_reconnect_supervisor(database_url.to_string(), database.clone(), connection);
        Ok(Self {
            database,
            owner_writes: Arc::new(crate::webhooks::pool::Pool::new(database_url, 4)),
            key_check_key: hmac_sha256(&encryption_key, &[KEY_CHECK_SUBKEY_LABEL]),
            idempotency_key: hmac_sha256(&encryption_key, &[IDEMPOTENCY_SUBKEY_LABEL]),
            encryption_key,
        })
    }

    /// `HMAC-SHA256(ENCRYPTION_KEY, label)`: a key for one purpose, so the
    /// encryption key itself serves only XChaCha20-Poly1305 (as with the
    /// key-check buckets' subkey).
    pub(crate) fn derive_subkey(&self, label: &[u8]) -> [u8; 32] {
        hmac_sha256(&self.encryption_key, &[label])
    }

    /// An `Idempotency-Key` as a no-credential connection sends it upstream:
    /// base64url (unpadded) of `HMAC-SHA256(subkey, connection_id ‖ 0 ‖
    /// key)` under `derive_subkey(IDEMPOTENCY_SUBKEY_LABEL)`. Stable for one
    /// connection and key, so a retry matches; different across connections,
    /// so tenants sharing the provider's key space never collide; and the
    /// caller's key cannot be read back from it.
    pub fn connection_idempotency_key(&self, connection_id: &str, key: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(hmac_sha256(
            &self.idempotency_key,
            &[connection_id.as_bytes(), b"\0", key],
        ))
    }

    /// The client currently backing this connection. Held only for the
    /// duration of one query: a reconnect replaces the shared client without
    /// invalidating a client already in hand.
    async fn client(&self) -> Arc<Client> {
        self.database.read().await.clone()
    }

    /// Lightweight readiness probe for callers (health checks, startup
    /// diagnostics) that want to know whether the database is currently
    /// reachable without triggering the normal error-mapping of a query.
    pub async fn is_ready(&self) -> bool {
        self.client().await.simple_query("SELECT 1").await.is_ok()
    }

    /// Atomically records a nonce. A duplicate nonce is a replay. Kept for
    /// ten minutes: twice the signature clock skew, so a signed request can
    /// never be accepted again after its record is swept.
    pub async fn consume_nonce(&self, nonce: &str) -> Result<bool, String> {
        let database = self.client().await;
        database
            .execute("DELETE FROM used_challenges WHERE expires_at <= NOW()", &[])
            .await
            .map_err(db_error)?;
        let rows = database.execute("INSERT INTO used_challenges (nonce, expires_at) VALUES ($1, NOW() + INTERVAL '10 minutes') ON CONFLICT DO NOTHING", &[&nonce]).await.map_err(db_error)?;
        Ok(rows == 1)
    }

    /// Whether `nonce` is recorded and not yet expired, without recording
    /// it.
    pub async fn nonce_used(&self, nonce: &str) -> Result<bool, String> {
        let row = self
            .client()
            .await
            .query_opt(
                "SELECT 1 FROM used_challenges WHERE nonce = $1 AND expires_at > NOW()",
                &[&nonce],
            )
            .await
            .map_err(db_error)?;
        Ok(row.is_some())
    }

    /// Spends a signed request's replay key, as [`Self::consume_nonce`] does,
    /// but also refuses it while `legacy_key` is recorded: that is the same
    /// request's key in the earlier format, written by an older proxy
    /// instance during a rolling deploy. Never writes `legacy_key`.
    pub async fn consume_request(&self, key: &str, legacy_key: &str) -> Result<bool, String> {
        let database = self.client().await;
        database
            .execute("DELETE FROM used_challenges WHERE expires_at <= NOW()", &[])
            .await
            .map_err(db_error)?;
        let rows = database
            .execute(
                "INSERT INTO used_challenges (nonce, expires_at) \
                 SELECT $1, NOW() + INTERVAL '10 minutes' \
                 WHERE NOT EXISTS (SELECT 1 FROM used_challenges WHERE nonce = $2) \
                 ON CONFLICT DO NOTHING",
                &[&key, &legacy_key],
            )
            .await
            .map_err(db_error)?;
        Ok(rows == 1)
    }

    /// The `key_check_limits` bucket of one client network and platform: a
    /// hex HMAC-SHA256 of both under a subkey derived from `ENCRYPTION_KEY`
    /// (`HMAC(ENCRYPTION_KEY, "integration-proxy-key-check-limit-v1")`), so
    /// the address cannot be read back from a row or a log line, nor found
    /// by hashing every IPv4 address without the key. (The platform is
    /// logged next to the bucket on purpose.)
    pub fn key_check_bucket(&self, platform: &str, network: &str) -> String {
        hmac_sha256(
            &self.key_check_key,
            &[platform.as_bytes(), b"\0", network.as_bytes()],
        )
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
    }

    /// Takes one of `bucket`'s `limit` key checks. Each is a row
    /// `(bucket, slot)` for one of the slots `1..=limit`, kept for `window`
    /// after it was taken, so at most `limit` checks are made in any
    /// `window` (a sliding window), across instances and concurrent
    /// requests: the primary key lets only one request take a slot. `None`
    /// when a check was taken; otherwise the seconds until a slot frees.
    pub async fn take_key_check_allowance(
        &self,
        bucket: &str,
        limit: u32,
        window: Duration,
    ) -> Result<Option<u64>, String> {
        let limit = i32::try_from(limit).unwrap_or(i32::MAX);
        let window = window.as_secs_f64();
        let database = self.client().await;
        database
            .execute(
                "DELETE FROM key_check_limits WHERE expires_at <= NOW()",
                &[],
            )
            .await
            .map_err(db_error)?;
        // Each pass takes the lowest free (or expired, not yet swept) slot,
        // finds every slot taken, or loses that slot to a concurrent
        // request and tries again; there are only `limit` slots to lose.
        for _ in 0..=limit {
            let taken = database
                .execute(
                    "INSERT INTO key_check_limits (bucket, slot, expires_at) \
                     SELECT $1, s, NOW() + make_interval(secs => $3) \
                     FROM generate_series(1, $2) AS s \
                     WHERE NOT EXISTS (SELECT 1 FROM key_check_limits k \
                       WHERE k.bucket = $1 AND k.slot = s AND k.expires_at > NOW()) \
                     ORDER BY s LIMIT 1 \
                     ON CONFLICT (bucket, slot) DO UPDATE SET expires_at = EXCLUDED.expires_at \
                     WHERE key_check_limits.expires_at <= NOW()",
                    &[&bucket, &limit, &window],
                )
                .await
                .map_err(db_error)?;
            if taken == 1 {
                return Ok(None);
            }
            let row = database
                .query_one(
                    "SELECT COUNT(*), EXTRACT(EPOCH FROM MIN(expires_at) - NOW())::float8 \
                     FROM key_check_limits WHERE bucket = $1 AND expires_at > NOW()",
                    &[&bucket],
                )
                .await
                .map_err(db_error)?;
            let (count, next_free): (i64, Option<f64>) = (row.get(0), row.get(1));
            if count >= i64::from(limit) {
                return Ok(Some(next_free.unwrap_or(1.0).ceil().max(1.0) as u64));
            }
        }
        Ok(Some(1))
    }

    pub fn seal(&self, plaintext: &[u8], associated_data: &[u8]) -> Result<String, String> {
        let cipher = XChaCha20Poly1305::new((&self.encryption_key).into());
        let mut nonce = [0u8; 24];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: associated_data,
                },
            )
            .map_err(|_| "encryption failed")?;
        Ok(format!(
            "v1.{}.{}",
            URL_SAFE_NO_PAD.encode(nonce),
            URL_SAFE_NO_PAD.encode(ciphertext)
        ))
    }

    pub fn open(&self, envelope: &str, associated_data: &[u8]) -> Option<Vec<u8>> {
        let (version, value) = envelope.split_once('.')?;
        if version != "v1" {
            return None;
        }
        let (nonce, ciphertext) = value.split_once('.')?;
        let nonce = URL_SAFE_NO_PAD.decode(nonce).ok()?;
        let ciphertext = URL_SAFE_NO_PAD.decode(ciphertext).ok()?;
        if nonce.len() != 24 {
            return None;
        }
        XChaCha20Poly1305::new((&self.encryption_key).into())
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: associated_data,
                },
            )
            .ok()
    }

    pub async fn store_connect_state(
        &self,
        state: &str,
        value: &ConnectState,
    ) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute("DELETE FROM connect_states WHERE expires_at <= NOW()", &[])
            .await
            .map_err(db_error)?;
        database.execute("INSERT INTO connect_states (state, platform, verifier, context, expires_at) VALUES ($1,$2,$3,$4,NOW() + INTERVAL '10 minutes')", &[&state, &value.platform, &value.verifier, &value.context]).await.map_err(db_error)?;
        Ok(())
    }

    pub async fn take_connect_state(&self, state: &str) -> Result<Option<ConnectState>, String> {
        let row = self.client().await.query_opt("DELETE FROM connect_states WHERE state = $1 AND expires_at > NOW() RETURNING platform, verifier, context", &[&state]).await.map_err(db_error)?;
        Ok(row.map(|r| ConnectState {
            platform: r.get(0),
            verifier: r.get(1),
            context: r.get(2),
        }))
    }

    /// Stores a single-use handoff, redeemable for five minutes by whoever
    /// proves the PKCE verifier for `challenge`.
    pub async fn store_handoff(
        &self,
        code: &str,
        challenge: &str,
        envelope: &str,
    ) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute(
                "DELETE FROM connection_handoffs WHERE expires_at <= NOW()",
                &[],
            )
            .await
            .map_err(db_error)?;
        database.execute("INSERT INTO connection_handoffs (code, challenge, envelope, expires_at) VALUES ($1,$2,$3,NOW() + INTERVAL '5 minutes')", &[&code, &challenge, &envelope]).await.map_err(db_error)?;
        Ok(())
    }

    /// Validate PKCE and consume atomically; a wrong verifier cannot burn a valid code.
    pub async fn take_handoff(
        &self,
        code: &str,
        challenge: &str,
    ) -> Result<Option<String>, String> {
        self.client().await.query_opt("DELETE FROM connection_handoffs WHERE code = $1 AND challenge = $2 AND expires_at > NOW() RETURNING envelope", &[&code, &challenge]).await.map_err(db_error).map(|row| row.map(|r| r.get(0)))
    }

    /// Deletes every connection idle for [`CONNECTION_IDLE_DAYS`], with its
    /// delegations. Runs whenever a connection is created, and is harmless to
    /// run more often.
    pub async fn sweep_idle_connections(&self) -> Result<u64, String> {
        self.client()
            .await
            .execute(
                "DELETE FROM agent_connections WHERE last_used_at <= NOW() - make_interval(days => $1)",
                &[&CONNECTION_IDLE_DAYS],
            )
            .await
            .map_err(db_error)
    }

    /// Creates a connection owned by `owner` (a canonical agent id) holding
    /// `credential` (a serialized `StoredCredential`), and returns its new
    /// random id. The row is the credential's only server-side copy.
    #[cfg(test)]
    pub async fn create_connection(
        &self,
        platform: &str,
        owner: &str,
        credential: &[u8],
    ) -> Result<String, String> {
        self.create_labelled_connection(platform, owner, credential, None)
            .await
    }

    /// [`Self::create_connection`] with a display label, sealed like the
    /// credential (it can be personal data, such as an email address).
    pub async fn create_labelled_connection(
        &self,
        platform: &str,
        owner: &str,
        credential: &[u8],
        label: Option<&str>,
    ) -> Result<String, String> {
        self.sweep_idle_connections().await?;
        let connection_id = crate::connect::random();
        let envelope = self.seal(credential, &connection_aad(&connection_id))?;
        let label_envelope = label
            .map(|label| self.seal(label.as_bytes(), &connection_label_aad(&connection_id)))
            .transpose()?;
        let mut client = self.owner_writes.get().await?;
        let tx = client.transaction().await.map_err(db_error)?;
        lock_owners(&tx, &[owner]).await?;
        if retired_in(&tx, &[owner]).await? {
            return Err(OWNER_RETIRED.into());
        }
        tx.execute(
            "INSERT INTO agent_connections (connection_id, platform, owner, envelope, label_envelope) VALUES ($1,$2,$3,$4,$5)",
            &[&connection_id, &platform, &owner, &envelope, &label_envelope],
        )
        .await
        .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(connection_id)
    }

    /// Test-only: points a connection at `owner` directly, as a row stranded
    /// before the owner locks existed would be.
    #[cfg(test)]
    pub(crate) async fn force_owner_for_tests(&self, connection_id: &str, owner: &str) {
        self.client()
            .await
            .execute(
                "UPDATE agent_connections SET owner = $2 WHERE connection_id = $1",
                &[&connection_id, &owner],
            )
            .await
            .unwrap();
    }

    /// Test-only: adds a delegation without the owner checks.
    #[cfg(test)]
    pub(crate) async fn force_delegation_for_tests(&self, connection_id: &str, agent: &str) {
        self.client()
            .await
            .execute(
                "INSERT INTO connection_delegations (connection_id, agent) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                &[&connection_id, &agent],
            )
            .await
            .unwrap();
    }

    /// Whether `agent` was retired by a transfer (#410).
    pub async fn is_retired(&self, agent: &str) -> Result<bool, String> {
        self.client()
            .await
            .query_opt("SELECT 1 FROM retired_agents WHERE agent = $1", &[&agent])
            .await
            .map(|row| row.is_some())
            .map_err(db_error)
    }

    /// Moves `from`'s connections and runtimes to `to` and retires `from`,
    /// in one statement, so either all of it happens or none: a collision
    /// (a runtime `to` already has) undoes the retirement too. Refused when
    /// either id is retired. Delegations are keyed by connection and app
    /// agent and need no change.
    ///
    /// One transaction, holding both owners' advisory locks ([`lock_owners`])
    /// and the old owner's connection rows (`FOR UPDATE`): retirement is
    /// checked under the locks, so of two concurrent transfers A→B and B→C
    /// the second sees the first's retirement; a connection, runtime or
    /// delegation write of either owner waits for it; and a webhook
    /// subscription (which takes its connection row `FOR SHARE`) either
    /// committed before the open-subscriptions check, which then refuses
    /// the transfer, or finds the connection moved. The subscriptions table
    /// is checked whenever it exists, also with the webhook inbox off.
    pub async fn transfer_owner(&self, from: &str, to: &str) -> Result<Transferred, TransferError> {
        let database = |error: tokio_postgres::Error| {
            if error.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) {
                TransferError::Conflict
            } else {
                TransferError::Database(db_error(error))
            }
        };
        let mut client = self
            .owner_writes
            .get()
            .await
            .map_err(TransferError::Database)?;
        let tx = client.transaction().await.map_err(database)?;
        lock_owners(&tx, &[from, to])
            .await
            .map_err(TransferError::Database)?;
        if retired_in(&tx, &[from, to])
            .await
            .map_err(TransferError::Database)?
        {
            return Err(TransferError::Retired);
        }
        tx.execute(
            "SELECT 1 FROM agent_connections WHERE owner = $1 FOR UPDATE",
            &[&from],
        )
        .await
        .map_err(database)?;
        let open: bool = tx
            .query_one(
                "SELECT to_regclass('webhook_subscriptions') IS NOT NULL",
                &[],
            )
            .await
            .map_err(database)?
            .get(0);
        if open
            && tx
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM webhook_subscriptions WHERE owner = $1 AND state <> 'closed')",
                    &[&from],
                )
                .await
                .map_err(database)?
                .get::<_, bool>(0)
        {
            return Err(TransferError::Blocked);
        }
        tx.execute(
            "INSERT INTO retired_agents (agent, successor) VALUES ($1, $2)",
            &[&from, &to],
        )
        .await
        .map_err(database)?;
        let connections = tx
            .execute(
                "UPDATE agent_connections SET owner = $2 WHERE owner = $1",
                &[&from, &to],
            )
            .await
            .map_err(database)?;
        let runtimes = tx
            .execute(
                "UPDATE app_runtimes SET owner = $2 WHERE owner = $1",
                &[&from, &to],
            )
            .await
            .map_err(database)?;
        tx.commit().await.map_err(database)?;
        Ok(Transferred {
            connections: connections as i64,
            runtimes: runtimes as i64,
        })
    }

    /// Reads a live connection without marking it used; the caller has not
    /// authenticated yet. `None` for an unknown, idle-expired or tampered row.
    pub async fn load_connection(
        &self,
        connection_id: &str,
    ) -> Result<Option<ConnectionRecord>, String> {
        let row = self
            .client()
            .await
            .query_opt(
                "SELECT platform, owner, envelope FROM agent_connections WHERE connection_id = $1 AND last_used_at > NOW() - make_interval(days => $2)",
                &[&connection_id, &CONNECTION_IDLE_DAYS],
            )
            .await
            .map_err(db_error)?;
        Ok(row.and_then(|row| {
            let envelope: String = row.get(2);
            Some(ConnectionRecord {
                connection_id: connection_id.to_owned(),
                platform: row.get(0),
                owner: row.get(1),
                credential: self.open(&envelope, &connection_aad(connection_id))?,
            })
        }))
    }

    /// How `agent` stands towards a connection owned by `owner`. Evaluated on
    /// every request, so deleting a delegation or a runtime takes effect on
    /// the next one.
    pub async fn standing(
        &self,
        connection_id: &str,
        owner: &str,
        agent: &str,
    ) -> Result<Standing, String> {
        if agent == owner {
            return Ok(Standing::Owner);
        }
        let database = self.client().await;
        let direct = database
            .query_opt(
                "SELECT 1 FROM connection_delegations WHERE connection_id = $1 AND agent = $2",
                &[&connection_id, &agent],
            )
            .await
            .map_err(db_error)?;
        if direct.is_some() {
            return Ok(Standing::Delegate);
        }
        let runtime = database
            .query_opt(
                "SELECT r.app FROM app_runtimes r JOIN connection_delegations d ON d.agent = r.app AND d.connection_id = $1 WHERE r.owner = $2 AND r.agent = $3",
                &[&connection_id, &owner, &agent],
            )
            .await
            .map_err(db_error)?;
        Ok(match runtime {
            Some(row) => Standing::Runtime { app: row.get(0) },
            None => Standing::None,
        })
    }

    /// Whether `app` holds a delegation for the connection.
    pub async fn is_delegated(&self, connection_id: &str, app: &str) -> Result<bool, String> {
        Ok(self
            .client()
            .await
            .query_opt(
                "SELECT 1 FROM connection_delegations WHERE connection_id = $1 AND agent = $2",
                &[&connection_id, &app],
            )
            .await
            .map_err(db_error)?
            .is_some())
    }

    /// Records an authenticated use, restarting the idle clock, and when the
    /// request came through a delegation, when that delegation (and runtime)
    /// was last used, for the management UI.
    pub async fn touch(
        &self,
        connection_id: &str,
        delegate: Option<&str>,
        runtime: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let database = self.client().await;
        database
            .execute(
                "UPDATE agent_connections SET last_used_at = NOW() WHERE connection_id = $1",
                &[&connection_id],
            )
            .await
            .map_err(db_error)?;
        if let Some(agent) = delegate {
            database
                .execute(
                    "UPDATE connection_delegations SET last_used_at = NOW() WHERE connection_id = $1 AND agent = $2",
                    &[&connection_id, &agent],
                )
                .await
                .map_err(db_error)?;
        }
        if let Some((owner, agent)) = runtime {
            database
                .execute(
                    "UPDATE app_runtimes SET last_used_at = NOW() WHERE owner = $1 AND agent = $2",
                    &[&owner, &agent],
                )
                .await
                .map_err(db_error)?;
        }
        Ok(())
    }

    /// Deletes a connection and its delegations if `owner` owns it. Returns
    /// whether a row was deleted.
    pub async fn delete_connection(
        &self,
        connection_id: &str,
        owner: &str,
    ) -> Result<bool, String> {
        self.client()
            .await
            .execute(
                "DELETE FROM agent_connections WHERE connection_id = $1 AND owner = $2",
                &[&connection_id, &owner],
            )
            .await
            .map(|rows| rows == 1)
            .map_err(db_error)
    }

    /// Adds (or relabels) a delegation of a connection `owner` owns, under
    /// the owner's lock. `false` when the connection is not `owner`'s (any
    /// more): nothing is written.
    pub async fn put_delegation(
        &self,
        connection_id: &str,
        owner: &str,
        agent: &str,
        label: Option<&str>,
    ) -> Result<bool, String> {
        let mut client = self.owner_writes.get().await?;
        let tx = client.transaction().await.map_err(db_error)?;
        lock_owners(&tx, &[owner]).await?;
        if retired_in(&tx, &[owner]).await? {
            return Err(OWNER_RETIRED.into());
        }
        let rows = tx
            .execute(
                "INSERT INTO connection_delegations (connection_id, agent, label)
                 SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM agent_connections WHERE connection_id = $1 AND owner = $4)
                 ON CONFLICT (connection_id, agent) DO UPDATE SET label = EXCLUDED.label",
                &[&connection_id, &agent, &label, &owner],
            )
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(rows == 1)
    }

    /// Removes a delegation of a connection `owner` owns, under the owner's
    /// lock; `false` when there was none (or the connection is not
    /// `owner`'s).
    pub async fn delete_delegation(
        &self,
        connection_id: &str,
        owner: &str,
        agent: &str,
    ) -> Result<bool, String> {
        let mut client = self.owner_writes.get().await?;
        let tx = client.transaction().await.map_err(db_error)?;
        lock_owners(&tx, &[owner]).await?;
        if retired_in(&tx, &[owner]).await? {
            return Err(OWNER_RETIRED.into());
        }
        let rows = tx
            .execute(
                "DELETE FROM connection_delegations d WHERE d.connection_id = $1 AND d.agent = $2
                 AND EXISTS (SELECT 1 FROM agent_connections c WHERE c.connection_id = $1 AND c.owner = $3)",
                &[&connection_id, &agent, &owner],
            )
            .await
            .map_err(db_error)?;
        tx.commit().await.map_err(db_error)?;
        Ok(rows == 1)
    }

    /// Registers `agent` as a runtime of installation `app` for `owner`
    /// (decision 10). A runtime belongs to one app; registering it again
    /// moves it.
    pub async fn put_runtime(
        &self,
        owner: &str,
        agent: &str,
        app: &str,
        label: Option<&str>,
    ) -> Result<(), String> {
        let mut client = self.owner_writes.get().await?;
        let tx = client.transaction().await.map_err(db_error)?;
        lock_owners(&tx, &[owner]).await?;
        if retired_in(&tx, &[owner]).await? {
            return Err(OWNER_RETIRED.into());
        }
        tx.execute(
            "INSERT INTO app_runtimes (owner, agent, app, label) VALUES ($1,$2,$3,$4) ON CONFLICT (owner, agent) DO UPDATE SET app = EXCLUDED.app, label = EXCLUDED.label",
            &[&owner, &agent, &app, &label],
        )
        .await
        .map_err(db_error)?;
        tx.commit().await.map_err(db_error)
    }

    pub async fn delete_runtime(&self, owner: &str, agent: &str) -> Result<bool, String> {
        self.client()
            .await
            .execute(
                "DELETE FROM app_runtimes WHERE owner = $1 AND agent = $2",
                &[&owner, &agent],
            )
            .await
            .map(|rows| rows == 1)
            .map_err(db_error)
    }

    /// The owner's live connections with their delegations, and the owner's
    /// runtimes, for the management UI. Never includes credentials.
    pub async fn list_for_owner(
        &self,
        owner: &str,
    ) -> Result<(Vec<ConnectionInfo>, Vec<RuntimeInfo>), String> {
        let database = self.client().await;
        let rows = database
            .query(
                "SELECT connection_id, platform, created_at, last_used_at, label_envelope FROM agent_connections WHERE owner = $1 AND last_used_at > NOW() - make_interval(days => $2) ORDER BY created_at",
                &[&owner, &CONNECTION_IDLE_DAYS],
            )
            .await
            .map_err(db_error)?;
        let mut connections = Vec::with_capacity(rows.len());
        for row in rows {
            let connection_id: String = row.get(0);
            let delegations = database
                .query(
                    "SELECT agent, label, created_at, last_used_at FROM connection_delegations WHERE connection_id = $1 ORDER BY created_at",
                    &[&connection_id],
                )
                .await
                .map_err(db_error)?
                .into_iter()
                .map(|d| DelegationInfo {
                    agent: d.get(0),
                    label: d.get(1),
                    created_at: timestamp(d.get(2)),
                    last_used_at: d.get::<_, Option<std::time::SystemTime>>(3).map(timestamp),
                })
                .collect();
            let label = row
                .get::<_, Option<String>>(4)
                .and_then(|envelope| self.open(&envelope, &connection_label_aad(&connection_id)))
                .and_then(|label| String::from_utf8(label).ok());
            connections.push(ConnectionInfo {
                connection_id,
                platform: row.get(1),
                owner: owner.to_owned(),
                label,
                created_at: timestamp(row.get(2)),
                last_used_at: timestamp(row.get(3)),
                delegations,
            });
        }
        let runtimes = database
            .query(
                "SELECT agent, app, label, created_at, last_used_at FROM app_runtimes WHERE owner = $1 ORDER BY created_at",
                &[&owner],
            )
            .await
            .map_err(db_error)?
            .into_iter()
            .map(|r| RuntimeInfo {
                agent: r.get(0),
                app: r.get(1),
                label: r.get(2),
                created_at: timestamp(r.get(3)),
                last_used_at: r.get::<_, Option<std::time::SystemTime>>(4).map(timestamp),
            })
            .collect();
        Ok((connections, runtimes))
    }

    /// Claims the right to refresh this connection's OAuth token. At most one
    /// caller holds it at a time, across processes: two concurrent refreshes
    /// would both spend the same refresh token, and a provider that rotates
    /// refresh tokens (or detects reuse) would then revoke the grant. A
    /// caller that does not get the lease re-reads the row instead.
    pub async fn claim_refresh_lease(&self, connection_id: &str) -> Result<bool, String> {
        self.client()
            .await
            .execute(
                "UPDATE agent_connections SET refresh_lease_until = NOW() + make_interval(secs => $2) WHERE connection_id = $1 AND (refresh_lease_until IS NULL OR refresh_lease_until <= NOW())",
                &[&connection_id, &REFRESH_LEASE_SECONDS],
            )
            .await
            .map(|rows| rows == 1)
            .map_err(db_error)
    }

    /// Stores a refreshed credential and releases the refresh lease.
    pub async fn store_refreshed_connection(
        &self,
        connection_id: &str,
        credential: &[u8],
    ) -> Result<(), String> {
        let envelope = self.seal(credential, &connection_aad(connection_id))?;
        self.client()
            .await
            .execute(
                "UPDATE agent_connections SET envelope = $2, refresh_lease_until = NULL WHERE connection_id = $1",
                &[&connection_id, &envelope],
            )
            .await
            .map(|_| ())
            .map_err(db_error)
    }

    /// Releases the refresh lease after a failed refresh, leaving the stored
    /// credential as it was.
    pub async fn release_refresh_lease(&self, connection_id: &str) -> Result<(), String> {
        self.client()
            .await
            .execute(
                "UPDATE agent_connections SET refresh_lease_until = NULL WHERE connection_id = $1",
                &[&connection_id],
            )
            .await
            .map(|_| ())
            .map_err(db_error)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::sync::Barrier;

    pub(crate) const TEST_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    pub(crate) fn test_database_url() -> String {
        std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated test database")
    }

    pub(crate) async fn admin() -> tokio_postgres::Client {
        let (admin, connection) =
            tokio_postgres::connect(&test_database_url(), tokio_postgres::NoTls)
                .await
                .expect("admin connection");
        tokio::spawn(async move {
            let _ = connection.await;
        });
        admin
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn concurrent_connections_initialize_a_fresh_schema() {
        let database_url = test_database_url();
        let admin = admin().await;
        let schema = format!("security_connect_{:016x}", rand::random::<u64>());
        admin
            .batch_execute(&format!("CREATE SCHEMA \"{schema}\""))
            .await
            .expect("create test schema");
        let mut scoped_url = url::Url::parse(&database_url).expect("parse TEST_DATABASE_URL");
        scoped_url
            .query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        let scoped_url = scoped_url.to_string();
        let barrier = Arc::new(Barrier::new(8));
        let mut connections = tokio::task::JoinSet::new();
        for _ in 0..8 {
            let barrier = barrier.clone();
            let scoped_url = scoped_url.clone();
            connections.spawn(async move {
                barrier.wait().await;
                Security::connect(&scoped_url, TEST_KEY).await
            });
        }

        let mut initialized = Vec::new();
        let mut errors = Vec::new();
        while let Some(result) = connections.join_next().await {
            match result.expect("initializer task") {
                Ok(security) => initialized.push(security),
                Err(error) => errors.push(error),
            }
        }
        drop(initialized);
        admin
            .batch_execute(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
            .await
            .expect("drop test schema");

        assert!(
            errors.is_empty(),
            "concurrent schema initialization failed: {errors:?}"
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn recovers_after_the_database_connection_is_dropped() {
        let database_url = test_database_url();
        let tag = format!("security_reconnect_{:016x}", rand::random::<u64>());
        let mut tagged_url = url::Url::parse(&database_url).expect("parse TEST_DATABASE_URL");
        tagged_url
            .query_pairs_mut()
            .append_pair("application_name", &tag);
        let security = Security::connect(tagged_url.as_ref(), TEST_KEY)
            .await
            .expect("initial connection");
        assert!(security.is_ready().await);

        let admin = admin().await;
        let terminated = admin
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
                &[&tag],
            )
            .await
            .expect("terminate the security connection's backend");
        assert!(
            terminated > 0,
            "expected to terminate at least one backend for {tag}"
        );

        let mut healed = false;
        for _ in 0..50 {
            if security.is_ready().await {
                healed = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(healed, "connection did not recover after being terminated");

        // A real write, not just the readiness probe, proves the reconnected
        // client is fully usable and schema state survived the reconnect.
        assert!(security
            .consume_nonce(&format!("post-reconnect-{tag}"))
            .await
            .expect("query after reconnect"));
    }

    #[test]
    fn hmac_sha256_matches_rfc_4231() {
        // RFC 4231, test case 2.
        let mac = hmac_sha256(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        let hex: String = mac.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// A no-credential connection's `Idempotency-Key` is an HMAC under its
    /// own derived subkey: per connection, stable, never the caller's key.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn idempotency_keys_are_namespaced_per_connection_under_a_derived_subkey() {
        let security = crate::test_support::security().await;
        let subkey = hmac_sha256(&security.encryption_key, &[IDEMPOTENCY_SUBKEY_LABEL]);
        assert_eq!(security.idempotency_key, subkey);
        assert_ne!(subkey, security.key_check_key);
        let key = security.connection_idempotency_key("conn-a", b"create-1");
        assert_eq!(
            key,
            URL_SAFE_NO_PAD.encode(hmac_sha256(&subkey, &[b"conn-a", b"\0", b"create-1"]))
        );
        assert_eq!(
            key,
            security.connection_idempotency_key("conn-a", b"create-1")
        );
        assert_ne!(
            key,
            security.connection_idempotency_key("conn-b", b"create-1")
        );
        assert_ne!(
            key,
            security.connection_idempotency_key("conn-a", b"create-2")
        );
        // The separator keeps (id, key) pairs from running together.
        assert_ne!(
            security.connection_idempotency_key("ab", b"c"),
            security.connection_idempotency_key("a", b"bc")
        );
    }

    /// The key-check buckets are keyed by a subkey derived from
    /// `ENCRYPTION_KEY`, never by the encryption key itself.
    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn key_check_buckets_use_a_derived_subkey() {
        let security = crate::test_support::security().await;
        let subkey = hmac_sha256(&security.encryption_key, &[KEY_CHECK_SUBKEY_LABEL]);
        assert_eq!(security.key_check_key, subkey);
        assert_ne!(security.key_check_key, security.encryption_key);
        let hex = |mac: [u8; 32]| mac.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let bucket = security.key_check_bucket("clockify", "198.51.100.7");
        assert_eq!(
            bucket,
            hex(hmac_sha256(&subkey, &[b"clockify", b"\0", b"198.51.100.7"]))
        );
        assert_ne!(
            bucket,
            hex(hmac_sha256(
                &security.encryption_key,
                &[b"clockify", b"\0", b"198.51.100.7"]
            ))
        );
        assert_ne!(
            bucket,
            security.key_check_bucket("clockify", "198.51.100.8")
        );
        assert_ne!(
            bucket,
            security.key_check_bucket("clockify-x", "198.51.100.7")
        );
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn nonces_are_single_use() {
        let security = Security::connect(&test_database_url(), TEST_KEY)
            .await
            .unwrap();
        let nonce = format!("nonce-{:016x}", rand::random::<u64>());
        assert!(security.consume_nonce(&nonce).await.unwrap());
        assert!(!security.consume_nonce(&nonce).await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn a_connection_row_is_bound_to_its_id_and_expires_after_90_idle_days() {
        let security = Security::connect(&test_database_url(), TEST_KEY)
            .await
            .unwrap();
        let admin = admin().await;
        let owner = format!("atomic:agent:owner-{:016x}", rand::random::<u64>());
        let a = security
            .create_connection("github-issues", &owner, b"credential-a")
            .await
            .unwrap();
        let b = security
            .create_connection("github-issues", &owner, b"credential-b")
            .await
            .unwrap();
        assert_eq!(
            security
                .load_connection(&a)
                .await
                .unwrap()
                .unwrap()
                .credential,
            b"credential-a"
        );
        // One row's envelope pasted into another does not open.
        admin
            .execute(
                "UPDATE agent_connections SET envelope = (SELECT envelope FROM agent_connections WHERE connection_id = $1) WHERE connection_id = $2",
                &[&a, &b],
            )
            .await
            .unwrap();
        assert!(security.load_connection(&b).await.unwrap().is_none());

        // 89 idle days: still there. 90: gone, and swept with its delegations.
        security
            .put_delegation(&a, &owner, "atomic:agent:app", None)
            .await
            .unwrap();
        admin
            .execute(
                "UPDATE agent_connections SET last_used_at = NOW() - INTERVAL '89 days' WHERE connection_id = $1",
                &[&a],
            )
            .await
            .unwrap();
        assert!(security.load_connection(&a).await.unwrap().is_some());
        security.touch(&a, None, None).await.unwrap();
        admin
            .execute(
                "UPDATE agent_connections SET last_used_at = NOW() - INTERVAL '90 days 1 second' WHERE connection_id = $1",
                &[&a],
            )
            .await
            .unwrap();
        assert!(security.load_connection(&a).await.unwrap().is_none());
        assert!(security
            .list_for_owner(&owner)
            .await
            .unwrap()
            .0
            .iter()
            .all(|c| c.connection_id != a));
        security.sweep_idle_connections().await.unwrap();
        let remaining: i64 = admin
            .query_one(
                "SELECT (SELECT COUNT(*) FROM agent_connections WHERE connection_id = $1) + (SELECT COUNT(*) FROM connection_delegations WHERE connection_id = $1)",
                &[&a],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn standing_follows_delegations_and_runtimes_immediately() {
        let security = Security::connect(&test_database_url(), TEST_KEY)
            .await
            .unwrap();
        let tag = rand::random::<u64>();
        let owner = format!("atomic:agent:owner-{tag:016x}");
        let app = format!("atomic:agent:app-{tag:016x}");
        let node = format!("atomic:agent:node-{tag:016x}");
        let id = security
            .create_connection("github-issues", &owner, b"c")
            .await
            .unwrap();
        let other = security
            .create_connection("github-issues", &owner, b"c")
            .await
            .unwrap();
        assert_eq!(
            security.standing(&id, &owner, &owner).await.unwrap(),
            Standing::Owner
        );
        assert_eq!(
            security.standing(&id, &owner, &app).await.unwrap(),
            Standing::None
        );
        security
            .put_delegation(&id, &owner, &app, Some("Plugin"))
            .await
            .unwrap();
        assert_eq!(
            security.standing(&id, &owner, &app).await.unwrap(),
            Standing::Delegate
        );
        assert_eq!(
            security.standing(&other, &owner, &app).await.unwrap(),
            Standing::None
        );
        assert_eq!(
            security.standing(&id, &owner, &node).await.unwrap(),
            Standing::None
        );
        security
            .put_runtime(&owner, &node, &app, Some("server"))
            .await
            .unwrap();
        assert_eq!(
            security.standing(&id, &owner, &node).await.unwrap(),
            Standing::Runtime { app: app.clone() }
        );
        // A runtime registered by someone else's owner does not count.
        assert_eq!(
            security
                .standing(&id, &owner, &format!("atomic:agent:stranger-{tag:016x}"))
                .await
                .unwrap(),
            Standing::None
        );
        security
            .touch(&id, Some(&app), Some((&owner, &node)))
            .await
            .unwrap();
        let (connections, runtimes) = security.list_for_owner(&owner).await.unwrap();
        let listed = connections.iter().find(|c| c.connection_id == id).unwrap();
        assert_eq!(listed.delegations.len(), 1);
        assert_eq!(listed.delegations[0].agent, app);
        assert!(listed.delegations[0].last_used_at.is_some());
        assert_eq!(runtimes.len(), 1);
        assert!(runtimes[0].last_used_at.is_some());
        // Revoking the delegation cuts off the app and its runtime at once.
        assert!(security.delete_delegation(&id, &owner, &app).await.unwrap());
        assert_eq!(
            security.standing(&id, &owner, &app).await.unwrap(),
            Standing::None
        );
        assert_eq!(
            security.standing(&id, &owner, &node).await.unwrap(),
            Standing::None
        );
        security
            .put_delegation(&id, &owner, &app, None)
            .await
            .unwrap();
        assert!(security.delete_runtime(&owner, &node).await.unwrap());
        assert_eq!(
            security.standing(&id, &owner, &node).await.unwrap(),
            Standing::None
        );
        // Only the owner deletes.
        assert!(!security.delete_connection(&id, &app).await.unwrap());
        assert!(security.delete_connection(&id, &owner).await.unwrap());
        assert!(security.load_connection(&id).await.unwrap().is_none());
        assert!(!security.is_delegated(&id, &app).await.unwrap());
    }

    #[tokio::test]
    #[ignore = "requires TEST_DATABASE_URL; CI runs with --include-ignored"]
    async fn only_one_caller_holds_the_refresh_lease() {
        let security = Security::connect(&test_database_url(), TEST_KEY)
            .await
            .unwrap();
        let id = security
            .create_connection("github-issues", "atomic:agent:lease", b"old")
            .await
            .unwrap();
        let (a, b) = tokio::join!(
            security.claim_refresh_lease(&id),
            security.claim_refresh_lease(&id)
        );
        assert_ne!(a.unwrap(), b.unwrap());
        security
            .store_refreshed_connection(&id, b"new")
            .await
            .unwrap();
        assert_eq!(
            security
                .load_connection(&id)
                .await
                .unwrap()
                .unwrap()
                .credential,
            b"new"
        );
        assert!(security.claim_refresh_lease(&id).await.unwrap());
        security.release_refresh_lease(&id).await.unwrap();
        assert!(security.claim_refresh_lease(&id).await.unwrap());
    }
}
