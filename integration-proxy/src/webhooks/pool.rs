//! A few dedicated PostgreSQL connections for the inbox's transactions.
//!
//! The shared [`crate::security::Security`] client cannot run a
//! transaction (that needs `&mut Client`), and the inbox needs several
//! statements under row locks to stay within its limits. A closed
//! connection (an outage, a terminated backend) is dropped, and the next
//! caller connects again; a request during an outage fails instead of
//! waiting.

use tokio::sync::{Mutex, Semaphore, SemaphorePermit};
use tokio_postgres::Client;

const LOCK_TIMEOUT_MS: u64 = 10_000;
const STATEMENT_TIMEOUT_MS: u64 = 30_000;

pub struct Pool {
    database_url: String,
    idle: Mutex<Vec<Client>>,
    permits: Semaphore,
}

/// A connection taken from the pool; it goes back on drop unless closed.
pub struct PooledClient<'a> {
    client: Option<Client>,
    pool: &'a Pool,
    _permit: SemaphorePermit<'a>,
}

impl Pool {
    pub fn new(database_url: &str, size: usize) -> Self {
        Self {
            database_url: database_url.to_owned(),
            idle: Mutex::new(Vec::new()),
            permits: Semaphore::new(size),
        }
    }

    pub async fn get(&self) -> Result<PooledClient<'_>, String> {
        let permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| "webhook pool closed".to_string())?;
        let reused = {
            let mut idle = self.idle.lock().await;
            let mut found = None;
            while let Some(client) = idle.pop() {
                if !client.is_closed() {
                    found = Some(client);
                    break;
                }
            }
            found
        };
        let client = match reused {
            Some(client) => client,
            None => {
                let (client, driver) = crate::security::connect_once(&self.database_url).await?;
                tokio::spawn(async move {
                    if let Err(error) = driver.await {
                        tracing::warn!(%error, "webhook inbox connection closed");
                    }
                });
                // No inbox statement waits for a lock, or runs, without
                // bound: a stuck one fails (and the provider may retry).
                client
                    .batch_execute(&format!(
                        "SET lock_timeout = '{LOCK_TIMEOUT_MS}ms'; SET statement_timeout = '{STATEMENT_TIMEOUT_MS}ms'"
                    ))
                    .await
                    .map_err(|e| e.to_string())?;
                client
            }
        };
        Ok(PooledClient {
            client: Some(client),
            pool: self,
            _permit: permit,
        })
    }
}

impl std::ops::Deref for PooledClient<'_> {
    type Target = Client;
    fn deref(&self) -> &Client {
        self.client.as_ref().expect("present until drop")
    }
}

impl std::ops::DerefMut for PooledClient<'_> {
    fn deref_mut(&mut self) -> &mut Client {
        self.client.as_mut().expect("present until drop")
    }
}

impl Drop for PooledClient<'_> {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            if !client.is_closed() {
                if let Ok(mut idle) = self.pool.idle.try_lock() {
                    idle.push(client);
                }
            }
        }
    }
}
