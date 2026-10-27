mod common;
use atomic_lib::{
    agents::{Agent, ForAgent},
    import_identity,
    sync::{engine, protocol},
    Db, Storelike, Value,
};
use serde_json::{json, Value as Json};
use syncables_atomic_peer::{
    tables::{NativeProjection, TABLE_BINDING},
    Peer, Session, PENDING_KEY,
};
const P: &str = "https://atomicdata.dev/properties/";
const C: &str = "https://atomicdata.dev/classes/";
fn external(s: &str) -> Json {
    json!({"external":s})
}
fn local(s: &str) -> Json {
    json!({"local":s})
}
fn property(name: &str, value: Json) -> Json {
    json!({"property":external(&format!("{P}{name}")),"value":value})
}
fn string(s: &str) -> Json {
    json!({"type":"string","value":s})
}
fn node(key: &str, parent: &str, classes: Vec<Json>, properties: Vec<Json>) -> Json {
    json!({"key":key,"parent":local(parent),"classes":classes,"properties":properties})
}
fn plan(owner: &Agent, revision: u8, present: bool) -> NativeProjection {
    let mut resources = vec![
        node(
            "account",
            "drive",
            vec![external(&format!("{C}Folder"))],
            vec![property("name", string("Work"))],
        ),
        node(
            "number",
            "drive",
            vec![external(&format!("{C}Property"))],
            vec![
                property("name", string("Number")),
                property("shortname", string("number")),
                property("description", string("Invented numeric column")),
                property(
                    "datatype",
                    json!({"type":"resource","value":external("https://atomicdata.dev/datatypes/integer")}),
                ),
            ],
        ),
        node(
            "class",
            "drive",
            vec![external(&format!("{C}Class"))],
            vec![
                property("name", string("Item")),
                property("shortname", string("item")),
                property("description", string("Invented row class")),
                property(
                    "requires",
                    json!({"type":"resources","value":[external(&format!("{P}name"))]}),
                ),
                property(
                    "recommends",
                    json!({"type":"resources","value":[local("number")]}),
                ),
            ],
        ),
        node(
            "table",
            "account",
            vec![external(&format!("{C}Table"))],
            vec![
                property("name", string("Issues")),
                property(
                    "classtype",
                    json!({"type":"resource","value":local("class")}),
                ),
            ],
        ),
        node(
            "other-table",
            "account",
            vec![external(&format!("{C}Table"))],
            vec![
                property("name", string("Comments")),
                property(
                    "classtype",
                    json!({"type":"resource","value":local("class")}),
                ),
            ],
        ),
    ];
    if present {
        resources.push(node(
            "row",
            "table",
            vec![local("class")],
            vec![
                property("name", string("A real table row")),
                json!({"property":local("number"),"value":{"type":"integer","value":revision}}),
            ],
        ));
    }
    serde_json::from_value(json!({"format":"atomic-tables-v2","owner":owner.subject.to_string(),"revision":format!("{revision:064x}"),"sources":[{"collection":"example/work/issues","revision":format!("{revision:064x}"),"documentHash":"a".repeat(64)}],"resources":resources})).unwrap()
}
async fn id(peer: &Peer, key: &str) -> String {
    import_identity::find_in_scope(
        &peer.db,
        &peer.drive.clone().into(),
        &format!("syncables:table-node:{key}"),
        true,
    )
    .await
    .unwrap()
    .unwrap()
}
#[tokio::test]
async fn native_tables_reconcile_preserve_identity_and_recover() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented table owner")).unwrap();
    let readers = vec![owner.subject.to_string()];
    let peer = Peer::open(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        TABLE_BINDING,
        &readers,
    )
    .await
    .unwrap();
    peer.project_tables(&plan(&owner, 1, true)).await.unwrap();
    let table = id(&peer, "table").await;
    let row = id(&peer, "row").await;
    let number = id(&peer, "number").await;
    let other = id(&peer, "other-table").await;
    let r = peer.db.get_resource(&row.clone().into()).await.unwrap();
    assert_eq!(r.get(&format!("{P}parent")).unwrap().to_string(), table);
    assert_eq!(r.get(&number).unwrap().to_int().unwrap(), 1);
    let other_vv =
        engine::build_drive_vvs(&peer.db, &std::collections::HashSet::from([other.clone()]));
    assert!(peer
        .project_tables(&plan(&owner, 1, true))
        .await
        .unwrap()
        .is_empty());
    peer.project_tables(&plan(&owner, 2, true)).await.unwrap();
    assert_eq!(
        engine::build_drive_vvs(&peer.db, &std::collections::HashSet::from([other.clone()])),
        other_vv
    );
    // The ordinary Atomic sync engine imports the generated folders, classes, properties and rows.
    let replica_dir = tempfile::tempdir().unwrap();
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
    let mut session = Session::new("http://127.0.0.1:9901".into());
    let auth =
        protocol::encode_auth(&owner, &format!("{}#{}", session.origin, session.nonce)).unwrap();
    assert_eq!(
        session.handle(&peer, &auth).await[0][0],
        protocol::tag::AUTH_OK
    );
    let vvs = engine::build_drive_vvs(&replica, &std::collections::HashSet::new());
    let frames = session
        .handle(&peer, &common::sync_frame(&peer.drive, &vvs))
        .await;
    for f in frames {
        if f[0] == protocol::tag::SYNC_PUSH {
            let push = protocol::decode_sync_push(&f[1..]).unwrap();
            let (count, _) = engine::import_sync_push(
                &push,
                &replica,
                &ForAgent::from(owner.subject.clone()),
                false,
            )
            .await
            .unwrap();
            assert_eq!(count, push.entries.len());
        }
    }
    assert_eq!(
        replica
            .get_resource(&row.clone().into())
            .await
            .unwrap()
            .get(&number)
            .unwrap()
            .to_int()
            .unwrap(),
        2
    );
    peer.project_tables(&plan(&owner, 3, false)).await.unwrap();
    assert_ne!(
        peer.db
            .get_resource(&row.clone().into())
            .await
            .unwrap()
            .get(&format!("{P}parent"))
            .unwrap()
            .to_string(),
        table
    );
    peer.project_tables(&plan(&owner, 4, true)).await.unwrap();
    assert_eq!(id(&peer, "row").await, row);
    // Reproduce an interrupted publication after the completion marker was saved.
    let mut partial = peer.db.get_resource(&row.clone().into()).await.unwrap();
    partial
        .set_unsafe(number.clone(), Value::Integer(99))
        .unwrap();
    partial.save(&peer.db).await.unwrap();
    peer.db
        .kv
        .insert(
            atomic_lib::db::trees::Tree::PluginMeta,
            PENDING_KEY,
            b"interrupted",
        )
        .unwrap();
    peer.db.flush().unwrap();
    let drive = peer.drive.clone();
    drop(peer);
    let peer = Peer::open(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        TABLE_BINDING,
        &readers,
    )
    .await
    .unwrap();
    peer.project_tables(&plan(&owner, 4, true)).await.unwrap();
    assert_eq!(peer.drive, drive);
    assert_eq!(id(&peer, "row").await, row);
    assert_eq!(
        peer.db
            .get_resource(&row.clone().into())
            .await
            .unwrap()
            .get(&number)
            .unwrap()
            .to_int()
            .unwrap(),
        4
    );
}
#[tokio::test]
async fn invalid_native_graph_never_advances_publication() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(None).unwrap();
    let peer = Peer::open(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        TABLE_BINDING,
        &[owner.subject.to_string()],
    )
    .await
    .unwrap();
    peer.project_tables(&plan(&owner, 1, true)).await.unwrap();
    let mut invalid = serde_json::to_value(plan(&owner, 2, true)).unwrap();
    invalid["resources"][0]["parent"] = local("missing");
    let invalid: NativeProjection = serde_json::from_value(invalid).unwrap();
    assert!(peer.project_tables(&invalid).await.is_err());
    assert_eq!(
        peer.status().await.unwrap().revision,
        Some(format!("{:064x}", 1))
    );
    let mut invalid = serde_json::to_value(plan(&owner, 2, true)).unwrap();
    invalid["resources"][5]["properties"][1]["value"]["value"] = json!(9007199254740992i64);
    let invalid: NativeProjection = serde_json::from_value(invalid).unwrap();
    assert!(peer.project_tables(&invalid).await.is_err());
    assert_eq!(
        peer.status().await.unwrap().revision,
        Some(format!("{:064x}", 1))
    );
}

#[tokio::test]
async fn inline_json_survives_native_persistence_without_child_resources() {
    let dir = tempfile::tempdir().unwrap();
    let owner = Agent::new(Some("Invented compact owner")).unwrap();
    let readers = vec![owner.subject.to_string()];
    let peer = Peer::open(
        dir.path(),
        owner.clone(),
        owner.subject.as_str(),
        TABLE_BINDING,
        &readers,
    )
    .await
    .unwrap();
    let mut projection = plan(&owner, 1, true);
    let payload = json!({"comments":[{"body":"Hello","author":{"name":"Alice","nickname":null}},null],"checks":[true,false],"empty":[]});
    projection.resources.push(serde_json::from_value(node("payload", "account", vec![external(&format!("{C}Property"))], vec![
        property("name", string("Body")),
        property("shortname", string("invented-body")),
        property("description", string("Invented inline body")),
        property("datatype", json!({"type":"resource","value":external("https://atomicdata.dev/datatypes/json")})),
    ])).unwrap());
    projection
        .resources
        .iter_mut()
        .find(|r| r.key == "row")
        .unwrap()
        .properties
        .push(
            serde_json::from_value(
                json!({"property":local("payload"),"value":{"type":"json","value":payload}}),
            )
            .unwrap(),
        );
    let node_count = projection.resources.len();
    peer.project_tables(&projection).await.unwrap();
    assert_eq!(projection.resources.len(), node_count);
    let row = id(&peer, "row").await;
    let property = id(&peer, "payload").await;
    let stored = peer.db.get_resource(&row.clone().into()).await.unwrap();
    match stored.get(&property).unwrap() {
        Value::Json(value) => assert_eq!(value, &payload),
        other => panic!("Expected native JSON, got {}", other),
    }
    let replica = Db::init_memory(None).await.unwrap();
    replica
        .add_resource(&owner.to_resource().unwrap())
        .await
        .unwrap();
    let mut session = Session::new("http://127.0.0.1:9901".into());
    let auth =
        protocol::encode_auth(&owner, &format!("{}#{}", session.origin, session.nonce)).unwrap();
    assert_eq!(
        session.handle(&peer, &auth).await[0][0],
        protocol::tag::AUTH_OK
    );
    let frames = session
        .handle(
            &peer,
            &common::sync_frame(&peer.drive, &std::collections::HashMap::new()),
        )
        .await;
    for frame in frames {
        if frame[0] == protocol::tag::SYNC_PUSH {
            let push = protocol::decode_sync_push(&frame[1..]).unwrap();
            engine::import_sync_push(&push, &replica, &ForAgent::from(owner.clone()), false)
                .await
                .unwrap();
        }
    }
    let imported = replica.get_resource(&row.into()).await.unwrap();
    assert!(matches!(imported.get(&property).unwrap(), Value::Json(value) if value == &payload));
}
