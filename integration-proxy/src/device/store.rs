//! Durable RFC 8628 grants and rotating token families. Every transition locks
//! its grant/session row in PostgreSQL; no process-local authentication state.
use super::{hash, secret, Error, READ_SCOPE};
use crate::security::Security;
use serde_json::{json, Value};

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS device_grants (
 device_hash TEXT PRIMARY KEY, user_hash TEXT UNIQUE NOT NULL,
 client_id TEXT NOT NULL, audience TEXT NOT NULL, scope TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, interval_secs INTEGER NOT NULL DEFAULT 5,
 next_poll TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '5 seconds',
 status TEXT NOT NULL DEFAULT 'pending', owner TEXT, connections TEXT[]
);
CREATE INDEX IF NOT EXISTS device_grants_expiry_idx ON device_grants(expires_at);
CREATE TABLE IF NOT EXISTS device_approval_challenges (
 challenge_hash TEXT PRIMARY KEY, device_hash TEXT NOT NULL REFERENCES device_grants ON DELETE CASCADE,
 owner TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS device_challenges_expiry_idx ON device_approval_challenges(expires_at);
CREATE INDEX IF NOT EXISTS device_challenges_grant_idx ON device_approval_challenges(device_hash);
CREATE TABLE IF NOT EXISTS device_sessions (
 session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, client_id TEXT NOT NULL,
 audience TEXT NOT NULL, scope TEXT NOT NULL, connections TEXT[] NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '30 days', revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS device_sessions_owner_idx ON device_sessions(owner);
CREATE INDEX IF NOT EXISTS device_sessions_expiry_idx ON device_sessions(expires_at);
CREATE TABLE IF NOT EXISTS device_access_tokens (
 token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES device_sessions ON DELETE CASCADE,
 expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '10 minutes'
);
CREATE INDEX IF NOT EXISTS device_access_session_idx ON device_access_tokens(session_id);
CREATE TABLE IF NOT EXISTS device_refresh_tokens (
 token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES device_sessions ON DELETE CASCADE,
 used BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS device_refresh_session_idx ON device_refresh_tokens(session_id);
";

// Serialize only allocations, preventing unbounded grants and session rows.
const ALLOCATION_LOCK: i64 = 5_650_862_800;

// Startup DDL takes the exclusive form of this lock. Sharing it prevents
// rolling-instance initialization from deadlocking with multi-table changes.
async fn migration_lock(tx: &tokio_postgres::Transaction<'_>) -> Result<(), Error> {
    tx.query_one(
        "SELECT pg_advisory_xact_lock_shared($1)",
        &[&crate::security::SCHEMA_LOCK],
    )
    .await?;
    Ok(())
}

async fn sweep(tx: &tokio_postgres::Transaction<'_>) -> Result<(), Error> {
    tx.execute(
        "DELETE FROM device_grants WHERE expires_at <= clock_timestamp()-INTERVAL '1 hour'",
        &[],
    )
    .await?;
    tx.execute(
        "DELETE FROM device_approval_challenges WHERE expires_at <= clock_timestamp()",
        &[],
    )
    .await?;
    tx.execute(
        "DELETE FROM device_sessions WHERE expires_at <= clock_timestamp()",
        &[],
    )
    .await?;
    tx.execute(
        "DELETE FROM device_access_tokens WHERE expires_at <= clock_timestamp()",
        &[],
    )
    .await?;
    Ok(())
}

pub async fn create(
    security: &Security,
    client: &str,
    audience: &str,
    scope: &str,
) -> Result<(String, String), Error> {
    let device = secret("lt_device_");
    // 50 bits; the alphabet avoids visually ambiguous characters.
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    // The 32-symbol alphabet is sampled uniformly.
    use rand::Rng;
    let user: String = (0..10)
        .map(|_| ALPHABET[rand::thread_rng().gen_range(0..ALPHABET.len())] as char)
        .collect();
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    tx.query_one("SELECT pg_advisory_xact_lock($1)", &[&ALLOCATION_LOCK])
        .await?;
    sweep(&tx).await?;
    let count: i64 = tx
        .query_one("SELECT COUNT(*) FROM device_grants", &[])
        .await?
        .get(0);
    if count >= 10_000 {
        return Err(Error::limited());
    }
    tx.execute("INSERT INTO device_grants(device_hash,user_hash,client_id,audience,scope,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+INTERVAL '10 minutes')", &[&hash(&device), &hash(&user), &client, &audience, &scope]).await?;
    tx.commit().await?;
    Ok((device, format!("{}-{}", &user[..5], &user[5..])))
}

pub async fn challenge(
    security: &Security,
    user: &str,
    owner: &str,
    audience: &str,
) -> Result<Value, Error> {
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    let row = tx.query_opt("SELECT device_hash, client_id, scope FROM device_grants WHERE user_hash=$1 AND audience=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE", &[&hash(user), &audience]).await?.ok_or(Error::oauth("invalid_grant"))?;
    let device: String = row.get(0);
    if !tx
        .query_one(
            "SELECT expires_at>clock_timestamp() FROM device_grants WHERE device_hash=$1",
            &[&device],
        )
        .await?
        .get::<_, bool>(0)
    {
        return Err(Error::oauth("invalid_grant"));
    }
    let challenge = secret("lt_approval_");
    tx.execute("DELETE FROM device_approval_challenges WHERE device_hash=$1 AND (owner=$2 OR expires_at<=clock_timestamp())", &[&device, &owner]).await?;
    let count: i64 = tx
        .query_one(
            "SELECT COUNT(*) FROM device_approval_challenges WHERE device_hash=$1",
            &[&device],
        )
        .await?
        .get(0);
    if count >= 20 {
        return Err(Error::limited());
    }
    tx.execute(
        "INSERT INTO device_approval_challenges VALUES($1,$2,$3,clock_timestamp()+INTERVAL '2 minutes')",
        &[&hash(&challenge), &device, &owner],
    )
    .await?;
    tx.commit().await?;
    Ok(
        json!({"challenge": challenge, "client_id": row.get::<_,String>(1), "scope": row.get::<_,String>(2), "expires_in":120}),
    )
}

pub async fn approve(
    security: &Security,
    challenge: &str,
    owner: &str,
    audience: &str,
    connections: &[String],
    approve: bool,
) -> Result<(), Error> {
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    // Read the challenge before locking the grant, always using the same lock
    // order as challenge() and poll(). The delete below consumes it once.
    let row = tx.query_opt("SELECT device_hash FROM device_approval_challenges WHERE challenge_hash=$1 AND owner=$2 AND expires_at>clock_timestamp()", &[&hash(challenge), &owner]).await?.ok_or(Error::oauth("invalid_grant"))?;
    let device: String = row.get(0);
    tx.query_opt("SELECT 1 FROM device_grants WHERE device_hash=$1 AND audience=$2 AND status='pending' AND expires_at>clock_timestamp() FOR UPDATE", &[&device, &audience]).await?.ok_or(Error::oauth("invalid_grant"))?;
    if tx.execute("DELETE FROM device_approval_challenges WHERE challenge_hash=$1 AND owner=$2 AND expires_at>clock_timestamp()", &[&hash(challenge), &owner]).await? != 1 { return Err(Error::oauth("invalid_grant")); }
    if approve {
        if connections.is_empty() || connections.len() > 20 {
            return Err(Error::oauth("invalid_request"));
        }
        // In connection_id order, the order a key transfer locks the same
        // rows in (`FOR UPDATE ... ORDER BY connection_id`), so the two cannot
        // deadlock.
        let mut ordered: Vec<&String> = connections.iter().collect();
        ordered.sort_unstable();
        ordered.dedup();
        for id in ordered {
            tx.query_opt("SELECT 1 FROM agent_connections WHERE connection_id=$1 AND owner=$2 AND last_used_at>clock_timestamp()-INTERVAL '90 days' FOR SHARE", &[&id, &owner]).await?.ok_or(Error::oauth("access_denied"))?;
        }
    }
    let status = if approve { "approved" } else { "denied" };
    if tx.execute(
        "UPDATE device_grants SET status=$2, owner=$3, connections=$4 WHERE device_hash=$1 AND expires_at>clock_timestamp() AND status='pending'",
        &[&device, &status, &owner, &connections],
    ).await? != 1 {
        return Err(Error::oauth("invalid_grant"));
    }
    tx.execute(
        "DELETE FROM device_approval_challenges WHERE device_hash=$1",
        &[&device],
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn issue(
    tx: &tokio_postgres::Transaction<'_>,
    session: &str,
    owner: &str,
    client: &str,
    scope: &str,
) -> Result<Value, Error> {
    let access = secret("lt_access_");
    let refresh = secret("lt_refresh_");
    tx.execute(
        "INSERT INTO device_access_tokens(token_hash,session_id) VALUES($1,$2)",
        &[&hash(&access), &session],
    )
    .await?;
    tx.execute(
        "INSERT INTO device_refresh_tokens(token_hash,session_id) VALUES($1,$2)",
        &[&hash(&refresh), &session],
    )
    .await?;
    Ok(
        json!({"access_token":access, "token_type":"Bearer", "expires_in":600, "refresh_token":refresh, "scope":scope, "owner":owner, "client_id":client, "session_id":session}),
    )
}

pub async fn poll(
    security: &Security,
    device: &str,
    client: &str,
    audience: &str,
) -> Result<Value, Error> {
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    let row = tx.query_opt("SELECT status, expires_at<=clock_timestamp(), next_poll>clock_timestamp(), interval_secs, owner, connections, scope FROM device_grants WHERE device_hash=$1 AND client_id=$2 AND audience=$3 FOR UPDATE", &[&hash(device), &client, &audience]).await?.ok_or(Error::oauth("invalid_grant"))?;
    // Re-evaluate time after the row lock: a request may have waited behind
    // another instance until after expiry or the polling interval changed.
    let timing = tx.query_one("SELECT expires_at<=clock_timestamp(), next_poll>clock_timestamp() FROM device_grants WHERE device_hash=$1", &[&hash(device)]).await?;
    if timing.get::<_, bool>(0) {
        return Err(Error::oauth("expired_token"));
    }
    let status: String = row.get(0);
    if status == "denied" {
        return Err(Error::oauth("access_denied"));
    }
    if status == "redeemed" {
        return Err(Error::oauth("invalid_grant"));
    }
    let early: bool = timing.get(1);
    let interval: i32 = row.get::<_, i32>(3) + if early { 5 } else { 0 };
    tx.execute("UPDATE device_grants SET interval_secs=$2, next_poll=clock_timestamp()+make_interval(secs=>$2::integer::double precision) WHERE device_hash=$1", &[&hash(device), &interval]).await?;
    if early || status == "pending" {
        tx.commit().await?;
        return Err(Error::oauth(if early {
            "slow_down"
        } else {
            "authorization_pending"
        }));
    }
    // Owner policy was checked on approval and is checked on every resource
    // request. Even if policy changes here, the issued token cannot use it.
    let owner: String = row.get(4);
    let connections: Vec<String> = row.get(5);
    let scope: String = row.get(6);
    tx.query_one("SELECT pg_advisory_xact_lock($1)", &[&ALLOCATION_LOCK])
        .await?;
    sweep(&tx).await?;
    let count: i64 = tx
        .query_one("SELECT COUNT(*) FROM device_sessions", &[])
        .await?
        .get(0);
    let owned: i64 = tx
        .query_one(
            "SELECT COUNT(*) FROM device_sessions WHERE owner=$1 AND NOT revoked",
            &[&owner],
        )
        .await?
        .get(0);
    if count >= 100_000 || owned >= 20 {
        return Err(Error::limited());
    }
    let session = secret("lt_session_");
    tx.execute("INSERT INTO device_sessions(session_id,owner,client_id,audience,scope,connections) VALUES($1,$2,$3,$4,$5,$6)", &[&session, &owner, &client, &audience, &scope, &connections]).await?;
    let response = issue(&tx, &session, &owner, client, &scope).await?;
    if tx.execute(
        "UPDATE device_grants SET status='redeemed' WHERE device_hash=$1 AND expires_at>clock_timestamp()",
        &[&hash(device)],
    ).await? != 1 {
        return Err(Error::oauth("expired_token"));
    }
    tx.commit().await?;
    Ok(response)
}

pub async fn refresh(
    security: &Security,
    token: &str,
    client: &str,
    audience: &str,
) -> Result<Value, Error> {
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    let row = tx.query_opt("SELECT s.session_id,s.owner,s.scope,s.revoked,s.expires_at<=clock_timestamp() FROM device_sessions s JOIN device_refresh_tokens r USING(session_id) WHERE r.token_hash=$1 AND s.client_id=$2 AND s.audience=$3 FOR UPDATE OF s", &[&hash(token), &client, &audience]).await?.ok_or(Error::oauth("invalid_grant"))?;
    let session: String = row.get(0);
    let expired: bool = tx
        .query_one(
            "SELECT expires_at<=clock_timestamp() FROM device_sessions WHERE session_id=$1",
            &[&session],
        )
        .await?
        .get(0);
    if row.get::<_, bool>(3) || expired {
        return Err(Error::oauth("invalid_grant"));
    }
    // A fresh statement after acquiring the family lock sees any rotation
    // that committed while we waited. Concurrent reuse revokes the family.
    let used: bool = tx
        .query_one(
            "SELECT used FROM device_refresh_tokens WHERE token_hash=$1",
            &[&hash(token)],
        )
        .await?
        .get(0);
    if used {
        tx.execute(
            "UPDATE device_sessions SET revoked=TRUE WHERE session_id=$1",
            &[&session],
        )
        .await?;
        tx.commit().await?;
        return Err(Error::oauth("invalid_grant"));
    }
    let rotations: i64 = tx
        .query_one(
            "SELECT COUNT(*) FROM device_refresh_tokens WHERE session_id=$1",
            &[&session],
        )
        .await?
        .get(0);
    if rotations >= 5000 {
        tx.execute(
            "UPDATE device_sessions SET revoked=TRUE WHERE session_id=$1",
            &[&session],
        )
        .await?;
        tx.commit().await?;
        return Err(Error::oauth("invalid_grant"));
    }
    tx.execute(
        "UPDATE device_refresh_tokens SET used=TRUE WHERE token_hash=$1",
        &[&hash(token)],
    )
    .await?;
    tx.execute(
        "DELETE FROM device_access_tokens WHERE session_id=$1",
        &[&session],
    )
    .await?;
    let response = issue(
        &tx,
        &session,
        &row.get::<_, String>(1),
        client,
        &row.get::<_, String>(2),
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}

/// Canonical owner identity plus the restricted client session; never an
/// alternate account/cache identity and never administrative owner authority.
pub struct Principal {
    pub owner: crate::AgentId,
    pub client_id: String,
    pub session_id: String,
    pub connections: Vec<String>,
    pub scope: String,
}

pub async fn authenticate(
    security: &Security,
    token: &str,
    audience: &str,
) -> Result<Principal, Error> {
    if !super::valid_secret(token, "lt_access_") {
        return Err(Error::invalid_token());
    }
    let row = security.client().await.query_opt("SELECT s.owner,s.client_id,s.session_id,s.connections,s.scope FROM device_access_tokens a JOIN device_sessions s USING(session_id) WHERE a.token_hash=$1 AND s.audience=$2 AND a.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND NOT s.revoked", &[&hash(token), &audience]).await?.ok_or(Error::invalid_token())?;
    Ok(Principal {
        owner: crate::parse_agent_id(&row.get::<_, String>(0)).ok_or(Error::invalid_token())?,
        client_id: row.get(1),
        session_id: row.get(2),
        connections: row.get(3),
        scope: row.get(4),
    })
}

pub async fn revoke(
    security: &Security,
    token: &str,
    client: &str,
    audience: &str,
) -> Result<(), Error> {
    let mut db = security.device_pool.get().await?;
    let tx = db.transaction().await?;
    migration_lock(&tx).await?;
    let row = tx.query_opt("SELECT s.session_id FROM device_sessions s WHERE s.client_id=$2 AND s.audience=$3 AND (EXISTS(SELECT 1 FROM device_access_tokens a WHERE a.session_id=s.session_id AND a.token_hash=$1) OR EXISTS(SELECT 1 FROM device_refresh_tokens r WHERE r.session_id=s.session_id AND r.token_hash=$1)) FOR UPDATE", &[&hash(token), &client, &audience]).await?;
    if let Some(row) = row {
        tx.execute(
            "UPDATE device_sessions SET revoked=TRUE WHERE session_id=$1",
            &[&row.get::<_, String>(0)],
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn sessions(security: &Security, owner: &str, audience: &str) -> Result<Value, Error> {
    let rows = security.client().await.query("SELECT session_id, client_id, scope, connections, revoked FROM device_sessions WHERE owner=$1 AND audience=$2 AND expires_at>clock_timestamp() ORDER BY session_id LIMIT 100", &[&owner, &audience]).await?;
    Ok(
        json!({"sessions":rows.iter().map(|r|json!({"session_id":r.get::<_,String>(0),"client_id":r.get::<_,String>(1),"scope":r.get::<_,String>(2),"connections":r.get::<_,Vec<String>>(3),"revoked":r.get::<_,bool>(4)})).collect::<Vec<_>>() }),
    )
}

pub async fn revoke_owned(
    security: &Security,
    owner: &str,
    session: &str,
    audience: &str,
) -> Result<(), Error> {
    let affected = security.client().await.execute("UPDATE device_sessions SET revoked=TRUE WHERE session_id=$1 AND owner=$2 AND audience=$3", &[&session,&owner,&audience]).await?;
    if affected != 1 {
        return Err(Error::oauth("invalid_grant"));
    }
    Ok(())
}

pub fn may_request(principal: &Principal, connection: &str, method: &axum::http::Method) -> bool {
    let needed = match *method {
        axum::http::Method::GET | axum::http::Method::HEAD => READ_SCOPE,
        axum::http::Method::POST
        | axum::http::Method::PUT
        | axum::http::Method::PATCH
        | axum::http::Method::DELETE => super::WRITE_SCOPE,
        _ => return false,
    };
    principal
        .scope
        .split_ascii_whitespace()
        .any(|s| s == needed)
        && principal.connections.iter().any(|id| id == connection)
}
