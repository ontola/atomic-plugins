use atomic_lib::{
    agents::Agent,
    errors::AtomicResult,
    sync::{engine, protocol},
};
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
    time::{Duration, Instant},
};
use syncables_atomic_peer::Peer;

/// The pinned core's periodic flush can briefly retain redb's file lock after
/// the last Peer is dropped. Gate a restart on actual database availability;
/// retry only that lock error, never a binding, validation or recovery error.
pub async fn open_peer(
    directory: &Path,
    signer: Agent,
    owner: &str,
    collection: &str,
    readers: &[String],
) -> AtomicResult<Peer> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match Peer::open(directory, signer.clone(), owner, collection, readers).await {
            Err(error)
                if error.message.contains("Database already open") && Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            result => return result,
        }
    }
}

/// The pinned core uses full vectors aligned with a sorted peer dictionary.
pub fn sync_frame(drive: &str, vvs: &HashMap<String, HashMap<String, i32>>) -> Vec<u8> {
    let peers: Vec<String> = vvs
        .values()
        .flat_map(|vv| vv.keys().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let resources = vvs
        .iter()
        .map(|(subject, vv)| {
            (
                subject.clone(),
                peers
                    .iter()
                    .map(|peer| vv.get(peer).copied().unwrap_or(0))
                    .collect(),
            )
        })
        .collect();
    protocol::encode_sync(drive, &engine::compute_drive_hash(vvs), &peers, &resources)
}
