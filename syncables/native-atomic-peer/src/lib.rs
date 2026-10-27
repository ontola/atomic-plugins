//! PostgreSQL is authoritative. This store contains only the signed native
//! projection and its durable identities, oplogs and completion checkpoint.
use atomic_lib::db::trees::Tree;
use atomic_lib::{
    agents::{Agent, ForAgent},
    errors::AtomicResult,
    import_identity,
    sync::{engine, protocol},
    urls, Db, Resource, Storelike, Subject, Value,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
pub mod tables;

pub const PENDING_KEY: &[u8] = b"syncables:projection-pending:v1";

pub const MAX_BYTES: usize = 64 * 1024 * 1024;
pub const CAPS: &[&str] = &[
    "auth-max-age",
    "auth-nonce",
    "keepalive",
    "unsub",
    "client-hello",
    "rebind-on-auth",
    "sync-probe",
    "get-many",
    "canonical-scheme",
];

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceResource {
    pub subject: String,
    pub raw: String,
    pub hash: String,
    pub item: bool,
    pub types: Vec<String>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Projection {
    pub owner: String,
    pub collection: String,
    pub scope: String,
    pub revision: String,
    pub context: String,
    pub resources: Vec<SourceResource>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub drive: String,
    pub revision: Option<String>,
    pub properties: BTreeMap<String, String>,
}
pub struct Peer {
    pub db: Db,
    pub drive: String,
    pub owner: String,
    pub collection: String,
    pub properties: BTreeMap<String, String>,
    published: AtomicBool,
    class: String,
}

fn text(resource: &Resource, prop: &str) -> Option<String> {
    resource.get(prop).ok().map(ToString::to_string)
}
fn canonical(id: &str) -> String {
    Subject::from_raw(id, None).pure_id()
}
fn subjects(values: impl IntoIterator<Item = String>) -> Value {
    Value::ResourceArray(values.into_iter().map(Into::into).collect())
}

async fn create_genesis(db: &Db, resource: Resource) -> AtomicResult<Resource> {
    let signer = db.get_default_agent()?;
    let commit =
        atomic_lib::Commit::create_did(resource.get_commit_builder().clone(), &signer, db).await?;
    let result = db
        .apply_commit(
            commit,
            &atomic_lib::commit::CommitOpts {
                validate_schema: true,
                validate_signature: true,
                update_index: true,
                ..atomic_lib::commit::CommitOpts::no_validations_no_index()
            },
        )
        .await?;
    result
        .resource_new
        .ok_or_else(|| "Genesis created no resource".into())
}

impl Peer {
    pub async fn open(
        directory: &Path,
        signer: Agent,
        owner: &str,
        collection: &str,
        readers: &[String],
    ) -> AtomicResult<Self> {
        if canonical(signer.subject.as_str()) != canonical(owner) {
            return Err("Selected signer does not match the configured owner".into());
        }
        if readers.is_empty()
            || readers.len() > 100
            || readers
                .iter()
                .any(|s| !canonical(s).starts_with("atomic:agent:"))
        {
            return Err("Select one to 100 native Atomic reader agents".into());
        }
        let db = Db::init_redb_file(directory, None, &directory.join("uploads")).await?;
        db.populate().await?;
        db.set_default_agent(signer.clone()); // In memory only; never persist a private key.
        db.add_resource(&signer.to_resource()?).await?;
        let legacy_binding =
            serde_json::to_string(&("syncables-peer-v1", canonical(owner), collection))?;
        // A bracket-prefixed String is guessed to be a ResourceArray by this
        // core pin. Keep the owner/collection tuple unambiguous on every read.
        let binding = format!("syncables-peer-v1:{legacy_binding}");
        let mut drives = db
            .all_resources(false)
            .filter(|r| r.has_class(urls::DRIVE))
            .collect::<Vec<_>>();
        let mut drive = if drives.is_empty() {
            let mut root = Resource::new("placeholder".into());
            root.set_class(urls::DRIVE)?;
            root.set_name(&if collection == tables::TABLE_BINDING {
                "SyncD".into()
            } else {
                format!("Syncables {collection}")
            })?;
            root.set_unsafe(urls::LOCAL_ID.into(), Value::String(binding.clone()))?;
            root.set_unsafe(urls::WRITE.into(), subjects([signer.subject.to_string()]))?;
            root.set_unsafe(
                urls::READ.into(),
                subjects(readers.iter().cloned().chain([signer.subject.to_string()])),
            )?;
            let root = create_genesis(&db, root).await?;
            db.flush()?;
            root
        } else {
            if drives.len() != 1 {
                return Err("Projection directory belongs to another owner or collection".into());
            }
            let root = drives.remove(0);
            // Match the authoritative String, rather than its lossy legacy
            // ResourceArray projection, before migrating an existing binding.
            let stored_binding = db
                .kv
                .get(Tree::LoroSnapshots, root.get_subject().pure_id().as_bytes())?
                .and_then(|snapshot| atomic_lib::loro::AtomicLoroDoc::from_snapshot(&snapshot).ok())
                .and_then(|doc| doc.get_string_property(urls::LOCAL_ID));
            if stored_binding.as_deref() != Some(&binding)
                && stored_binding.as_deref() != Some(&legacy_binding)
            {
                return Err("Projection directory belongs to another owner or collection".into());
            }
            // Hydrate existing CRDT state before any signed migration or grant edit.
            let mut root = db.get_resource(root.get_subject()).await?;
            if stored_binding.as_deref() == Some(&legacy_binding) {
                root.set_unsafe(urls::LOCAL_ID.into(), Value::String(binding.clone()))?;
                root.save(&db).await?;
                db.flush()?;
            }
            root
        };
        // Reader changes are explicit configuration changes; never retain an old grant.
        let mut grants: Vec<String> = readers
            .iter()
            .map(|s| canonical(s))
            .chain([canonical(signer.subject.as_str())])
            .collect();
        grants.sort();
        grants.dedup();
        let desired = subjects(grants);
        if text(&drive, urls::READ).as_deref() != Some(&desired.to_string()) {
            drive.set_unsafe(urls::READ.into(), desired)?;
            drive.save(&db).await?;
        }
        let drive = drive.get_subject().to_string();
        db.set_active_drive(&drive)?;
        let mut peer = Self {
            db,
            drive,
            owner: owner.into(),
            collection: collection.into(),
            properties: BTreeMap::new(),
            published: AtomicBool::new(false),
            class: String::new(),
        };
        if collection == tables::TABLE_BINDING {
            let id = peer
                .ensure(
                    "property",
                    "source-revision",
                    urls::PROPERTY,
                    vec![
                        (urls::SHORTNAME, Value::Slug("source-revision".into())),
                        (
                            urls::DESCRIPTION,
                            Value::Markdown("Completed native table graph revision.".into()),
                        ),
                        (urls::DATATYPE_PROP, Value::AtomicUrl(urls::STRING.into())),
                    ],
                )
                .await?;
            peer.properties.insert("source-revision".into(), id);
            peer.db.flush()?;
            return Ok(peer);
        }
        for (name, datatype, description) in [
            (
                "source-subject",
                urls::STRING,
                "Original PostgreSQL JSON-AD subject.",
            ),
            (
                "source-json-ad",
                urls::STRING,
                "Lossless JSON-AD text; parse with a lossless JSON parser.",
            ),
            (
                "source-hash",
                urls::STRING,
                "SHA-256 of the exact source-json-ad UTF-8 bytes.",
            ),
            (
                "source-revision",
                urls::STRING,
                "Pinned PostgreSQL revision; an observation, not provider deletion evidence.",
            ),
            ("source-scope", urls::STRING, "PostgreSQL collection scope."),
            (
                "source-context",
                urls::STRING,
                "Lossless source revision context JSON, including OAD provenance.",
            ),
            (
                "source-types",
                urls::RESOURCE_ARRAY,
                "Native wrappers of the bundled source schema identities.",
            ),
            (
                "members",
                urls::RESOURCE_ARRAY,
                "Records present in this completed collection revision.",
            ),
            (
                "schemas",
                urls::RESOURCE_ARRAY,
                "Bundled schema resources in this completed revision.",
            ),
        ] {
            let id = peer
                .ensure(
                    "property",
                    name,
                    urls::PROPERTY,
                    vec![
                        (urls::SHORTNAME, Value::Slug(name.into())),
                        (urls::DESCRIPTION, Value::Markdown(description.into())),
                        (urls::DATATYPE_PROP, Value::AtomicUrl(datatype.into())),
                    ],
                )
                .await?;
            peer.properties.insert(name.into(), id);
        }
        peer.class = peer.ensure("class", "source-resource", urls::CLASS, vec![
            (urls::SHORTNAME, Value::Slug("source-resource".into())),
            (urls::DESCRIPTION, Value::Markdown("Lossless source record or bundled source schema. Native wrapper identity is distinct from source identity.".into())),
            (urls::REQUIRES, subjects([peer.properties["source-subject"].clone(), peer.properties["source-json-ad"].clone()])),
        ]).await?;
        peer.db.flush()?;
        Ok(peer)
    }
    async fn ensure(
        &self,
        kind: &str,
        key: &str,
        class: &str,
        props: Vec<(&str, Value)>,
    ) -> AtomicResult<String> {
        let identity = format!("syncables:{kind}:{key}");
        if let Some(id) =
            import_identity::find_existing(&self.db, &self.drive.clone().into(), &identity).await?
        {
            return Ok(id);
        }
        let mut resource = Resource::new("placeholder".into());
        resource.set_class(class)?;
        resource.set_name(key)?;
        resource.set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl(self.drive.clone().into()),
        )?;
        resource.set_unsafe(urls::LOCAL_ID.into(), Value::String(identity))?;
        for (key, value) in props {
            resource.set_unsafe(key.into(), value)?;
        }
        let resource = create_genesis(&self.db, resource).await?;
        // Identity and genesis must survive even if publication is interrupted.
        self.db.flush()?;
        Ok(resource.get_subject().to_string())
    }
    pub async fn status(&self) -> AtomicResult<Status> {
        let root = self.db.get_resource(&self.drive.clone().into()).await?;
        Ok(Status {
            drive: self.drive.clone(),
            revision: text(&root, &self.properties["source-revision"]),
            properties: self.properties.clone(),
        })
    }
    pub async fn project(&self, projection: &Projection) -> AtomicResult<Vec<String>> {
        if self.collection == tables::TABLE_BINDING
            || projection.owner != self.owner
            || projection.collection != self.collection
            || projection.scope.is_empty()
            || projection.scope.len() > 8192
            || projection.revision.len() != 64
            || !projection.revision.bytes().all(|b| b.is_ascii_hexdigit())
            || projection.resources.len() > 50_000
        {
            return Err("Invalid projection binding, revision or size".into());
        }
        // Validate every object before changing any native resource. RawValue never
        // rounds numbers (including values outside f64 range).
        let _: Box<serde_json::value::RawValue> = serde_json::from_str(&projection.context)?;
        let mut seen = HashSet::new();
        let mut total = projection.context.len();
        for source in &projection.resources {
            total += source.raw.len();
            if total > 16 * 1024 * 1024
                || !seen.insert(&source.subject)
                || hex::encode(Sha256::digest(source.raw.as_bytes())) != source.hash
            {
                return Err("Invalid, duplicate or oversized source resource".into());
            }
            let object: BTreeMap<String, Box<serde_json::value::RawValue>> =
                serde_json::from_str(&source.raw)?;
            let subject: String =
                serde_json::from_str(object.get("@id").ok_or("Source has no subject")?.get())?;
            if subject != source.subject {
                return Err("Source subject mismatch".into());
            }
        }
        let mut root = self.db.get_resource(&self.drive.clone().into()).await?;
        let pending = self.db.kv.get(Tree::PluginMeta, PENDING_KEY)?.is_some();
        if text(&root, &self.properties["source-revision"]).as_deref() == Some(&projection.revision)
            && !pending
        {
            self.published.store(true, Ordering::Release);
            return Ok(vec![]);
        }
        self.published.store(false, Ordering::Release);
        // Journal BEFORE changing any document. A restart must replay even when
        // the final marker landed but acknowledgement/cleanup did not.
        self.db.kv.insert(
            Tree::PluginMeta,
            PENDING_KEY,
            projection.revision.as_bytes(),
        )?;
        self.db.flush()?;
        let mut mapping = BTreeMap::new();
        let mut changed = Vec::new();
        // First establish every identity so cross-schema references work regardless
        // of enumeration order. Provisional wrappers contain their complete source.
        for source in &projection.resources {
            let identity = format!("syncables:source:{}", source.subject);
            let old =
                import_identity::find_existing(&self.db, &self.drive.clone().into(), &identity)
                    .await?;
            let id = self
                .ensure(
                    "source",
                    &source.subject,
                    &self.class,
                    vec![
                        (
                            &self.properties["source-subject"],
                            Value::String(source.subject.clone()),
                        ),
                        (
                            &self.properties["source-json-ad"],
                            Value::String(source.raw.clone()),
                        ),
                    ],
                )
                .await?;
            if old.is_none() {
                changed.push(id.clone());
            }
            mapping.insert(source.subject.clone(), id);
        }
        for source in &projection.resources {
            let id = &mapping[&source.subject];
            let mut resource = self.db.get_resource(&id.clone().into()).await?;
            let types = subjects(source.types.iter().filter_map(|s| mapping.get(s).cloned()));
            if text(&resource, &self.properties["source-hash"]).as_deref() != Some(&source.hash)
                || text(&resource, &self.properties["source-types"]).as_deref()
                    != Some(&types.to_string())
            {
                resource.set_unsafe(
                    self.properties["source-json-ad"].clone(),
                    Value::String(source.raw.clone()),
                )?;
                resource.set_unsafe(
                    self.properties["source-hash"].clone(),
                    Value::String(source.hash.clone()),
                )?;
                resource.set_unsafe(
                    self.properties["source-revision"].clone(),
                    Value::String(projection.revision.clone()),
                )?;
                resource.set_unsafe(self.properties["source-types"].clone(), types)?;
                resource.save(&self.db).await?;
                if !changed.contains(id) {
                    changed.push(id.clone());
                }
            }
        }
        // Absence only removes collection membership. Keep the document, identity
        // and history so reappearance updates the same Loro document.
        for (name, item) in [("members", true), ("schemas", false)] {
            root.set_unsafe(
                self.properties[name].clone(),
                subjects(
                    projection
                        .resources
                        .iter()
                        .filter(|r| r.item == item)
                        .map(|r| mapping[&r.subject].clone()),
                ),
            )?;
        }
        root.set_unsafe(
            self.properties["source-context"].clone(),
            Value::String(projection.context.clone()),
        )?;
        root.set_unsafe(
            self.properties["source-scope"].clone(),
            Value::String(projection.scope.clone()),
        )?;
        // Flush required documents BEFORE publishing the completed revision.
        self.db.flush()?;
        root.set_unsafe(
            self.properties["source-revision"].clone(),
            Value::String(projection.revision.clone()),
        )?;
        root.save(&self.db).await?;
        self.db.flush()?;
        self.db.kv.remove(Tree::PluginMeta, PENDING_KEY)?;
        self.db.flush()?;
        self.published.store(true, Ordering::Release);
        changed.push(self.drive.clone()); // Completion notification is last.
        Ok(changed)
    }
}

/// Per-connection allowlist around the shared engine. All mutation tags are
/// rejected before the engine sees them, including writes signed by the owner.
pub struct Session {
    pub agent: ForAgent,
    pub subscribed: bool,
    pub nonce: String,
    pub origin: String,
    wire: engine::WireScheme,
}
impl Session {
    pub fn new(origin: String) -> Self {
        Self {
            agent: ForAgent::Public,
            subscribed: false,
            nonce: protocol::new_challenge_nonce(),
            origin,
            wire: engine::WireScheme::CANONICAL,
        }
    }
    pub async fn handle(&mut self, peer: &Peer, frame: &[u8]) -> Vec<Vec<u8>> {
        let Some(&tag) = frame.first() else {
            return vec![];
        };
        if tag == protocol::tag::AUTH {
            // Failed reauthentication must not preserve the old identity/grants.
            let was_subscribed = self.subscribed;
            self.agent = ForAgent::Public;
            self.subscribed = false;
            if frame.len() > 8192
                || serde_json::from_slice::<atomic_lib::authentication::AuthValues>(&frame[1..])
                    .is_ok_and(|auth| !canonical(&auth.agent_subject).starts_with("atomic:agent:"))
            {
                return vec![protocol::encode_error(
                    0,
                    protocol::error_code::AUTH_FAILED,
                    "Use a native Atomic agent",
                )];
            }
            let mut frames = engine::handle_auth_frame(
                &frame[1..],
                &peer.db,
                &mut self.agent,
                engine::AuthBinding::Origin(&self.origin),
                engine::AuthChallenge::Issued(&self.nonce),
            )
            .await;
            if frames.first().and_then(|f| f.first()) == Some(&protocol::tag::AUTH_OK) {
                if was_subscribed {
                    if let Ok(root) = peer.db.get_resource(&peer.drive.clone().into()).await {
                        self.subscribed =
                            atomic_lib::hierarchy::check_read(&peer.db, &root, &self.agent)
                                .await
                                .is_ok();
                    }
                }
                frames = vec![protocol::encode_auth_ok_with_caps(CAPS)];
            }
            return frames;
        }
        if tag == protocol::tag::HELLO {
            self.wire = engine::WireScheme::from_caps(&protocol::decode_hello_caps(&frame[1..]));
            return vec![];
        }
        if tag == protocol::tag::KEEPALIVE {
            return vec![protocol::encode_keepalive()];
        }
        let allowed = matches!(
            tag,
            protocol::tag::GET
                | protocol::tag::GET_MANY
                | protocol::tag::SUB
                | protocol::tag::UNSUB
                | protocol::tag::SYNC
        );
        if !allowed {
            let request = if tag == protocol::tag::COMMIT {
                protocol::decode_commit(&frame[1..])
                    .map(|c| c.request_id)
                    .unwrap_or(0)
            } else {
                0
            };
            return vec![protocol::encode_error(
                request,
                protocol::error_code::UNAUTHORIZED_WRITE,
                "Syncables peer is read-only",
            )];
        }
        if !peer.published.load(Ordering::Acquire) {
            return vec![protocol::encode_error(
                0,
                // This core pin predates a structured recovery/busy error.
                protocol::error_code::UNKNOWN,
                "Projection recovery required",
            )];
        }
        if matches!(self.agent, ForAgent::Public) {
            return vec![protocol::encode_error(
                0,
                protocol::error_code::UNAUTHORIZED_READ,
                "Authenticate before reading",
            )];
        }
        // In particular, the core's filtered/hash-match SYNC paths must not be
        // used to reveal state before the drive's read gate has been checked.
        let root = match peer.db.get_resource(&peer.drive.clone().into()).await {
            Ok(r) => r,
            Err(_) => return vec![],
        };
        if atomic_lib::hierarchy::check_read(&peer.db, &root, &self.agent)
            .await
            .is_err()
        {
            self.subscribed = false;
            return vec![protocol::encode_error(
                0,
                protocol::error_code::UNAUTHORIZED_READ,
                "Collection read denied",
            )];
        }
        if tag == protocol::tag::SYNC
            && protocol::decode_sync(&frame[1..])
                .is_none_or(|s| canonical(&s.drive) != canonical(&peer.drive))
        {
            return vec![protocol::encode_error(
                0,
                protocol::error_code::UNAUTHORIZED_READ,
                "Unknown drive",
            )];
        }
        if tag == protocol::tag::SUB
            && std::str::from_utf8(&frame[1..])
                .is_ok_and(|s| canonical(s) != canonical(&peer.drive))
        {
            return vec![protocol::encode_error(
                0,
                protocol::error_code::UNAUTHORIZED_READ,
                "Subscribe to the collection drive",
            )];
        }
        // Keep GET local, including misses inside a batch. The core's general
        // retrieval path may fetch an absent HTTP resource from another server.
        if tag == protocol::tag::GET_MANY {
            if let Some(get) = protocol::decode_get_many(&frame[1..]) {
                let mut answers = Vec::with_capacity(get.subjects.len());
                for subject in get.subjects {
                    if !peer.db.has_resource_locally(subject) {
                        answers.push(protocol::encode_error(
                            get.request_id,
                            protocol::error_code::UNKNOWN,
                            "Resource not in local projection",
                        ));
                    } else {
                        let get_frame = protocol::encode_get(get.request_id, subject);
                        answers.extend(
                            engine::handle_frame_for_caps(
                                &get_frame,
                                &peer.db,
                                &mut self.agent,
                                self.wire,
                            )
                            .await,
                        );
                    }
                }
                return vec![protocol::encode_get_many_result(get.request_id, &answers)];
            }
        }
        if tag == protocol::tag::GET {
            if let Some(get) = protocol::decode_get(&frame[1..]) {
                if !peer.db.has_resource_locally(get.subject) {
                    return vec![protocol::encode_error(
                        get.request_id,
                        protocol::error_code::UNKNOWN,
                        "Resource not in local projection",
                    )];
                }
            }
        }
        let out =
            engine::handle_frame_full_for_caps(frame, &peer.db, &mut self.agent, self.wire).await;
        if out.subscribe.is_some() {
            self.subscribed = true;
        }
        if out.unsubscribe.is_some() {
            self.subscribed = false;
        }
        out.frames
            .into_iter()
            .map(|frame| {
                // Even an owner replica is never asked to push its local edits.
                if frame.first() == Some(&protocol::tag::SYNC_DIFF) {
                    if let Some(diff) = protocol::decode_sync_diff(&frame[1..]) {
                        return protocol::encode_sync_diff(
                            &diff.drive,
                            &[],
                            &diff.push,
                            &diff.remove,
                            &HashMap::new(),
                            &diff.remove_commits,
                        );
                    }
                }
                frame
            })
            .collect()
    }
    pub async fn updates(&mut self, peer: &Peer, changed: &[String]) -> Vec<Vec<u8>> {
        if !self.subscribed {
            return vec![];
        }
        let mut frames = Vec::new();
        for subject in changed {
            let get = protocol::encode_get(0, subject);
            for mut frame in self.handle(peer, &get).await {
                if frame.first() == Some(&protocol::tag::UPDATE) {
                    frame[1] |= protocol::flags::PUSH;
                }
                frames.push(frame);
            }
        }
        frames
    }
}
