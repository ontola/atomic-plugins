mod common;
use atomic_lib::{
    agents::{Agent, ForAgent},
    sync::{engine, protocol},
    Db, Storelike,
};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use syncables_atomic_peer::{Peer, Projection, Session, SourceResource};

fn projection(owner: &Agent, revision: u8, value: &str, present: bool) -> Projection {
    let schema = "urn:invented:schema:note";
    let item = "urn:invented:note:1";
    let schema_raw =
        format!(r#"{{"@id":"{schema}","urn:invented:description":"Schema {revision}"}}"#);
    let raw = format!(
        r#"{{"@id":"{item}","urn:syncables:property:source-id":"1","urn:syncables:property:source-json":{{"value":{value},"empty":null,"nested":[true,"é"]}}}}"#
    );
    let wrap = |subject: &str, raw: String, item| SourceResource {
        subject: subject.into(),
        hash: hex::encode(Sha256::digest(raw.as_bytes())),
        raw,
        item,
        types: if item { vec![schema.into()] } else { vec![] },
    };
    let mut resources = vec![wrap(schema, schema_raw, false)];
    if present {
        resources.push(wrap(item, raw, true));
    }
    Projection {
        owner: owner.subject.to_string(),
        collection: "invented/work/notes".into(),
        scope: "invented-source-scope".into(),
        revision: format!("{revision:064x}"),
        context: r#"{"documentHash":"invented-oad-pin","resource":"note"}"#.into(),
        resources,
    }
}
async fn authenticate(peer: &Peer, reader: &Agent) -> Session {
    let mut session = Session::new("http://127.0.0.1:9901".into());
    let auth =
        protocol::encode_auth(reader, &format!("{}#{}", session.origin, session.nonce)).unwrap();
    let frames = session.handle(peer, &auth).await;
    assert_eq!(frames[0][0], protocol::tag::AUTH_OK);
    session
}
async fn reconcile(peer: &Peer, session: &mut Session, replica: &Db) -> (usize, usize) {
    let subjects = engine::collect_drive_subjects(replica, &peer.drive.clone().into()).await;
    let vvs = engine::build_drive_vvs(replica, &subjects);
    let frames = session
        .handle(peer, &common::sync_frame(&peer.drive, &vvs))
        .await;
    let mut entries = 0;
    let mut bytes = 0;
    for frame in frames {
        if frame[0] == protocol::tag::SYNC_DIFF {
            assert!(protocol::decode_sync_diff(&frame[1..])
                .unwrap()
                .pull
                .is_empty());
        }
        assert_ne!(
            frame[0],
            protocol::tag::ERROR,
            "{}",
            protocol::decode_error(&frame[1..])
                .map(|e| e.message)
                .unwrap_or_default()
        );
        if frame[0] == protocol::tag::SYNC_PUSH {
            let push = protocol::decode_sync_push(&frame[1..]).unwrap();
            bytes += push
                .entries
                .iter()
                .map(|e| e.loro_bytes.len())
                .sum::<usize>();
            let (count, _) = engine::import_sync_push(
                &push,
                replica,
                &ForAgent::from(peer.owner.clone()),
                false,
            )
            .await
            .unwrap();
            assert_eq!(
                count,
                push.entries.len(),
                "every native resource must validate"
            );
            entries += count;
        }
    }
    (entries, bytes)
}
async fn members(peer: &Peer, db: &Db) -> Vec<String> {
    db.get_resource(&peer.drive.clone().into())
        .await
        .unwrap()
        .get(&peer.properties["members"])
        .unwrap()
        .to_subjects(None)
        .unwrap()
}
#[tokio::test]
async fn persistent_signed_projection_syncs_losslessly_and_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let replica_dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented owner")).unwrap();
    let reader = Agent::new(Some("Invented reader")).unwrap();
    let readers = vec![reader.subject.to_string()];
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .unwrap();
    let first = projection(&owner, 1, "9007199254740993123456789.00100", true);
    peer.project(&first).await.unwrap();
    let drive = peer.drive.clone();
    let root = peer.db.get_resource(&drive.clone().into()).await.unwrap();
    assert_eq!(
        root.genesis_signer().as_deref(),
        Some(owner.subject.as_str())
    );
    let original = members(&peer, &peer.db).await[0].clone();
    let native = peer
        .db
        .get_resource(&original.clone().into())
        .await
        .unwrap();
    assert_eq!(
        native.genesis_signer().as_deref(),
        Some(owner.subject.as_str())
    );
    assert_eq!(
        native
            .get(atomic_lib::urls::DRIVE_PROP)
            .unwrap()
            .to_string(),
        peer.drive
    );
    let initial_vvs = engine::build_drive_vvs(
        &peer.db,
        &engine::collect_drive_subjects(&peer.db, &drive.clone().into()).await,
    );
    assert!(peer.project(&first).await.unwrap().is_empty());
    let replica = Db::init_redb_file(
        replica_dir.path(),
        None,
        &replica_dir.path().join("uploads"),
    )
    .await
    .unwrap();
    replica.populate().await.unwrap();
    replica
        .add_resource(&owner.to_resource().unwrap())
        .await
        .unwrap();
    let mut session = authenticate(&peer, &reader).await;
    let (count, full_bytes) = reconcile(&peer, &mut session, &replica).await;
    assert!(count > 10);
    let item = replica
        .get_resource(&original.clone().into())
        .await
        .unwrap();
    assert_eq!(
        item.get(&peer.properties["source-json-ad"])
            .unwrap()
            .to_string(),
        first.resources[1].raw
    );
    assert_eq!(reconcile(&peer, &mut session, &replica).await, (0, 0));
    drop(session);
    drop(peer);
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .unwrap();
    assert_eq!(peer.drive, drive);
    assert_eq!(
        peer.status().await.unwrap().revision.as_deref(),
        Some(first.revision.as_str())
    );
    let restarted = engine::build_drive_vvs(
        &peer.db,
        &engine::collect_drive_subjects(&peer.db, &drive.clone().into()).await,
    );
    assert_eq!(
        restarted, initial_vvs,
        "unchanged restart must create no operations"
    );
    peer.project(&projection(&owner, 2, "1e9999", true))
        .await
        .unwrap();
    let mut session = authenticate(&peer, &reader).await;
    let (delta_count, delta_bytes) = reconcile(&peer, &mut session, &replica).await;
    assert!(delta_count > 0 && delta_count < count);
    assert!(delta_bytes < full_bytes);
    assert_eq!(members(&peer, &replica).await, vec![original.clone()]);
    peer.project(&projection(&owner, 3, "0", false))
        .await
        .unwrap();
    reconcile(&peer, &mut session, &replica).await;
    assert!(members(&peer, &replica).await.is_empty());
    assert!(replica.has_resource_locally(&original));
    peer.project(&projection(&owner, 4, "-0.0000", true))
        .await
        .unwrap();
    reconcile(&peer, &mut session, &replica).await;
    assert_eq!(members(&peer, &replica).await, vec![original.clone()]);
    let item = replica.get_resource(&original.into()).await.unwrap();
    assert!(item
        .get(&peer.properties["source-json-ad"])
        .unwrap()
        .to_string()
        .contains("-0.0000"));
    assert_eq!(
        item.get(&peer.properties["source-types"])
            .unwrap()
            .to_subjects(None)
            .unwrap()
            .len(),
        1
    );
}
#[tokio::test]
async fn unauthorized_reads_all_mutations_and_cross_origin_auth_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Owner")).unwrap();
    let reader = Agent::new(Some("Reader")).unwrap();
    let stranger = Agent::new(Some("Stranger")).unwrap();
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &[reader.subject.to_string()],
    )
    .await
    .unwrap();
    peer.project(&projection(&owner, 1, "1", true))
        .await
        .unwrap();
    let mut public = Session::new("http://127.0.0.1:9901".into());
    assert_eq!(
        public
            .handle(&peer, &protocol::encode_get(1, &peer.drive))
            .await[0][0],
        protocol::tag::ERROR
    );
    let mut denied = authenticate(&peer, &stranger).await;
    for frame in [
        protocol::encode_get(1, &peer.drive),
        protocol::encode_sub(&peer.drive),
        protocol::encode_sync(&peer.drive, "", &[], &HashMap::new()),
        protocol::encode_sync_probe(
            &peer.drive,
            &engine::drive_sync_hash_for_wire(
                &peer.db,
                &peer.drive,
                &ForAgent::from(owner.subject.to_string()),
                engine::WireScheme::CANONICAL,
            )
            .await
            .unwrap(),
        ),
    ] {
        let reply = denied.handle(&peer, &frame).await;
        assert_eq!(
            protocol::decode_error(&reply[0][1..]).unwrap().code,
            protocol::error_code::UNAUTHORIZED_READ
        );
    }
    let mut session = authenticate(&peer, &owner).await;
    let frames = session
        .handle(
            &peer,
            &protocol::encode_get_many(42, &[&peer.drive, "https://unreachable.invalid/missing"]),
        )
        .await;
    assert_eq!(frames[0][0], protocol::tag::GET_MANY_RESULT);
    let batch = protocol::decode_get_many_result(&frames[0][1..]).unwrap();
    assert_eq!(batch.request_id, 42);
    assert_eq!(
        batch.frames.iter().map(|f| f[0]).collect::<Vec<_>>(),
        vec![protocol::tag::UPDATE, protocol::tag::ERROR]
    );
    let mut edit = peer
        .db
        .get_resource(&peer.drive.clone().into())
        .await
        .unwrap();
    edit.set_name("Consumer edit that must be refused").unwrap();
    let commit = edit
        .get_commit_builder()
        .clone()
        .sign(&owner, &peer.db, &edit)
        .await
        .unwrap();
    let signed = commit
        .into_resource(&peer.db)
        .await
        .unwrap()
        .to_json_ad(None)
        .unwrap();
    for frame in [
        protocol::encode_commit(6, &signed),
        protocol::encode_commit(7, "{}"),
        protocol::encode_destroy(8, &peer.drive),
        protocol::encode_sync_push(&peer.drive, &[], true),
        vec![protocol::tag::UPDATE],
        vec![protocol::tag::BLOB_RESPONSE],
        vec![protocol::tag::EPHEMERAL],
    ] {
        let reply = session.handle(&peer, &frame).await;
        assert_eq!(
            protocol::decode_error(&reply[0][1..]).unwrap().code,
            protocol::error_code::UNAUTHORIZED_WRITE
        );
    }
    session
        .handle(&peer, &protocol::encode_sub(&peer.drive))
        .await;
    assert!(session.subscribed);
    let frames = session
        .handle(
            &peer,
            &protocol::encode_auth(&reader, &format!("{}#{}", session.origin, session.nonce))
                .unwrap(),
        )
        .await;
    assert_eq!(frames[0][0], protocol::tag::AUTH_OK);
    assert!(
        session.subscribed,
        "a still-authorized identity keeps its subscription"
    );
    let frames = session
        .handle(
            &peer,
            &protocol::encode_auth(&stranger, &format!("{}#{}", session.origin, session.nonce))
                .unwrap(),
        )
        .await;
    assert_eq!(frames[0][0], protocol::tag::AUTH_OK);
    assert!(
        !session.subscribed,
        "switching to a denied reader drops its subscription"
    );
    let frames = session
        .handle(
            &peer,
            &protocol::encode_auth(&owner, "https://another.example").unwrap(),
        )
        .await;
    assert_eq!(
        protocol::decode_error(&frames[0][1..]).unwrap().code,
        protocol::error_code::AUTH_FAILED
    );
    assert!(!session.subscribed);
    assert!(matches!(session.agent, ForAgent::Public));
}
#[tokio::test]
async fn invalid_source_never_advances_checkpoint_and_bindings_are_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Owner")).unwrap();
    let readers = vec![owner.subject.to_string()];
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .unwrap();
    let first = projection(&owner, 1, "1", true);
    peer.project(&first).await.unwrap();
    let mut bad = projection(&owner, 2, "2", true);
    bad.resources[1].hash = "incorrect".into();
    assert!(peer.project(&bad).await.is_err());
    assert_eq!(
        peer.status().await.unwrap().revision.as_deref(),
        Some(first.revision.as_str())
    );
    drop(peer);
    let error = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "another/collection/notes",
        &readers,
    )
    .await
    .err()
    .expect("a different collection must be refused");
    assert!(error
        .message
        .contains("Projection directory belongs to another owner or collection"));
    let other = Agent::new(Some("Other")).unwrap();
    let error = common::open_peer(
        dir.path(),
        other,
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .err()
    .expect("a different signer must be refused");
    assert!(error
        .message
        .contains("Selected signer does not match the configured owner"));
}

#[tokio::test]
async fn interrupted_projection_is_replayed_before_it_can_be_served() {
    use atomic_lib::{db::trees::Tree, Value};
    use syncables_atomic_peer::PENDING_KEY;
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented owner")).unwrap();
    let readers = vec![owner.subject.to_string()];
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .unwrap();
    let first = projection(&owner, 1, "1.0000", true);
    peer.project(&first).await.unwrap();
    let id = members(&peer, &peer.db).await[0].clone();
    // Persist exactly the intermediate state of a later failed projection:
    // a journal and one changed native document, with the old completion marker.
    peer.db
        .kv
        .insert(
            Tree::PluginMeta,
            PENDING_KEY,
            format!("{:064x}", 2).as_bytes(),
        )
        .unwrap();
    let mut partial = peer.db.get_resource(&id.clone().into()).await.unwrap();
    partial
        .set_unsafe(
            peer.properties["source-json-ad"].clone(),
            Value::String("interrupted".into()),
        )
        .unwrap();
    partial
        .set_unsafe(
            peer.properties["source-hash"].clone(),
            Value::String("interrupted".into()),
        )
        .unwrap();
    partial.save(&peer.db).await.unwrap();
    peer.db.flush().unwrap();
    drop(peer);
    let peer = common::open_peer(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        "invented/work/notes",
        &readers,
    )
    .await
    .unwrap();
    let mut session = authenticate(&peer, &owner).await;
    let frames = session.handle(&peer, &protocol::encode_get(1, &id)).await;
    let refusal = protocol::decode_error(&frames[0][1..]).unwrap();
    assert_eq!(refusal.code, protocol::error_code::UNKNOWN);
    assert_eq!(refusal.message, "Projection recovery required");
    // The checkpoint equals the requested source revision, but a pending journal
    // forces reconciliation instead of taking the unchanged fast path.
    assert!(!peer.project(&first).await.unwrap().is_empty());
    assert!(peer
        .db
        .kv
        .get(Tree::PluginMeta, PENDING_KEY)
        .unwrap()
        .is_none());
    let restored = peer.db.get_resource(&id.into()).await.unwrap();
    assert_eq!(
        restored
            .get(&peer.properties["source-json-ad"])
            .unwrap()
            .to_string(),
        first.resources[1].raw
    );
    let frames = session
        .handle(&peer, &protocol::encode_get(2, &peer.drive))
        .await;
    assert_eq!(frames[0][0], protocol::tag::UPDATE);
}

#[tokio::test]
async fn legacy_binding_is_matched_exactly_and_migrated_with_stable_drive_identity() {
    use atomic_lib::{urls, Value};
    let directory = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented legacy owner")).unwrap();
    let readers = vec![owner.subject.to_string()];
    let collection = "invented/work/notes";
    let peer = common::open_peer(
        directory.path(),
        owner.clone(),
        owner.subject.as_str(),
        collection,
        &readers,
    )
    .await
    .unwrap();
    let first = projection(&owner, 1, "1", true);
    peer.project(&first).await.unwrap();
    let drive = peer.drive.clone();
    let legacy =
        serde_json::to_string(&("syncables-peer-v1", owner.subject.to_string(), collection))
            .unwrap();
    let mut root = peer.db.get_resource(&drive.clone().into()).await.unwrap();
    root.set_unsafe(urls::LOCAL_ID.into(), Value::String(legacy.clone()))
        .unwrap();
    root.save(&peer.db).await.unwrap();
    let before = peer
        .db
        .get_resource(&drive.clone().into())
        .await
        .unwrap()
        .get(urls::LAST_COMMIT)
        .unwrap()
        .to_string();
    peer.db.flush().unwrap();
    drop(peer);
    let peer = common::open_peer(
        directory.path(),
        owner.clone(),
        owner.subject.as_str(),
        collection,
        &readers,
    )
    .await
    .unwrap();
    assert_eq!(peer.drive, drive);
    assert_eq!(peer.status().await.unwrap().revision, Some(first.revision));
    let root = peer.db.get_resource(&drive.clone().into()).await.unwrap();
    let expected = format!("syncables-peer-v1:{legacy}");
    assert!(
        matches!(root.get(urls::LOCAL_ID).unwrap(), Value::String(value) if value == &expected)
    );
    let migrated_commit = root.get(urls::LAST_COMMIT).unwrap().to_string();
    assert_ne!(
        migrated_commit, before,
        "migration is an ordinary signed commit"
    );
    drop(peer);
    let peer = common::open_peer(
        directory.path(),
        owner.clone(),
        owner.subject.as_str(),
        collection,
        &readers,
    )
    .await
    .unwrap();
    assert_eq!(peer.drive, drive);
    let mut root = peer.db.get_resource(&drive.into()).await.unwrap();
    assert_eq!(
        root.get(urls::LAST_COMMIT).unwrap().to_string(),
        migrated_commit
    );
    // This distinct collection normalizes to the same Internal subject in the
    // old materialized array; exact matching must still refuse it.
    let wrong = serde_json::to_string(&(
        "syncables-peer-v1",
        owner.subject.to_string(),
        "internal:/invented/work/notes",
    ))
    .unwrap();
    root.set_unsafe(urls::LOCAL_ID.into(), Value::String(wrong))
        .unwrap();
    root.save(&peer.db).await.unwrap();
    peer.db.flush().unwrap();
    drop(peer);
    let error = common::open_peer(
        directory.path(),
        owner.clone(),
        owner.subject.as_str(),
        collection,
        &readers,
    )
    .await
    .err()
    .expect("a different legacy collection must be refused");
    assert!(error
        .message
        .contains("Projection directory belongs to another owner or collection"));
}
