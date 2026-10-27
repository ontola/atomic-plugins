use atomic_lib::sync::{engine, protocol};
use std::collections::{BTreeSet, HashMap};

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
