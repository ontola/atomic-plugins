//! Native table graph: no response JSON is stored in the Atomic replica.
use super::*;
use atomic_lib::datatype::match_datatype;

pub const TABLE_BINDING: &str = "syncables-atomic-tables-v1";
const STATE_KEY: &[u8] = b"syncables:table-state:v1";
#[derive(Deserialize, Serialize, Clone)]
#[serde(untagged, deny_unknown_fields)]
pub enum Reference {
    Local { local: String },
    External { external: String },
}
impl Reference {
    fn resolve(&self, ids: &BTreeMap<String, String>) -> AtomicResult<String> {
        match self {
            Self::Local { local } => ids
                .get(local)
                .cloned()
                .ok_or_else(|| "Unknown native graph reference".into()),
            Self::External { external } if external.starts_with("https://atomicdata.dev/") => {
                Ok(external.clone())
            }
            _ => Err("Native graph external references must be Atomic vocabulary terms".into()),
        }
    }
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum NativeValue {
    String(String),
    Integer(i64),
    Float(f64),
    Boolean(bool),
    Resource(Reference),
    Resources(Vec<Reference>),
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct PropertyValue {
    pub property: Reference,
    pub value: NativeValue,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NativeResource {
    pub key: String,
    pub parent: Reference,
    pub classes: Vec<Reference>,
    pub properties: Vec<PropertyValue>,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub collection: String,
    pub revision: String,
    pub document_hash: String,
}
#[derive(Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct NativeProjection {
    pub format: String,
    pub owner: String,
    pub revision: String,
    pub sources: Vec<Source>,
    pub resources: Vec<NativeResource>,
}
#[derive(Serialize, Deserialize, Default)]
struct State {
    ids: BTreeMap<String, String>,
    properties: BTreeMap<String, Vec<String>>,
}
fn revision(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn rank(resource: &NativeResource) -> u8 {
    if resource
        .classes
        .iter()
        .any(|r| matches!(r, Reference::External { external } if external == urls::PROPERTY))
    {
        0
    } else if resource
        .classes
        .iter()
        .any(|r| matches!(r, Reference::External { external } if external == urls::CLASS))
    {
        1
    } else {
        2
    }
}
impl Peer {
    pub async fn project_tables(&self, projection: &NativeProjection) -> AtomicResult<Vec<String>> {
        if self.collection != TABLE_BINDING
            || projection.format != "atomic-tables-v1"
            || projection.owner != self.owner
            || !revision(&projection.revision)
            || projection.resources.len() > 50_000
            || projection.sources.is_empty()
            || projection.sources.len() > 100
        {
            return Err("Invalid native table projection binding or size".into());
        }
        let mut keys = BTreeMap::from([("drive".to_string(), self.drive.clone())]);
        for resource in &projection.resources {
            if resource.key.is_empty()
                || resource.key.len() > 8192
                || keys.insert(resource.key.clone(), String::new()).is_some()
                || resource.classes.is_empty()
            {
                return Err("Duplicate or invalid native graph key".into());
            }
        }
        let mut collections = HashSet::new();
        for source in &projection.sources {
            if source.collection.is_empty()
                || !collections.insert(&source.collection)
                || !revision(&source.revision)
                || !revision(&source.document_hash)
            {
                return Err("Invalid native graph source revision".into());
            }
        }
        // Validate the whole graph before opening the publication journal.
        for resource in &projection.resources {
            resource.parent.resolve(&keys)?;
            for class in &resource.classes {
                class.resolve(&keys)?;
            }
            let mut properties = HashSet::new();
            for pair in &resource.properties {
                let property = pair.property.resolve(&keys)?;
                if !properties.insert(serde_json::to_string(&pair.property)?)
                    || [
                        urls::PARENT,
                        urls::DRIVE_PROP,
                        urls::IS_A,
                        urls::READ,
                        urls::WRITE,
                        urls::LOCAL_ID,
                        urls::GENESIS,
                    ]
                    .contains(&property.as_str())
                {
                    return Err("Duplicate or reserved native graph property".into());
                }
                match &pair.value {
                    NativeValue::Resource(r) => {
                        r.resolve(&keys)?;
                    }
                    NativeValue::Resources(rs) => {
                        for r in rs {
                            r.resolve(&keys)?;
                        }
                    }
                    NativeValue::Float(n) if !n.is_finite() => {
                        return Err("Non-finite native number".into())
                    }
                    NativeValue::Integer(n) if n.unsigned_abs() > 9_007_199_254_740_991 => {
                        return Err(
                            "Unsafe native integer; project exact numeric text instead".into()
                        )
                    }
                    _ => (),
                }
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
        self.db.kv.insert(
            Tree::PluginMeta,
            PENDING_KEY,
            projection.revision.as_bytes(),
        )?;
        self.db.flush()?;
        let mut state: State = self
            .db
            .kv
            .get(Tree::PluginMeta, STATE_KEY)?
            .map(|b| serde_json::from_slice(&b))
            .transpose()?
            .unwrap_or_default();
        let mut changed = Vec::new();
        // Allocate identities first, as generic resources, to allow forward links.
        // Every genesis binds the same drive; the final parent is an ordinary edit.
        for resource in &projection.resources {
            let identity = format!("syncables:table-node:{}", resource.key);
            let id = if let Some(id) = import_identity::find_in_scope(
                &self.db,
                &self.drive.clone().into(),
                &identity,
                true,
            )
            .await?
            {
                id
            } else {
                let mut r = Resource::new("placeholder".into());
                r.set_name("SyncD resource")?;
                r.set_unsafe(
                    urls::PARENT.into(),
                    Value::AtomicUrl(self.drive.clone().into()),
                )?;
                r.set_unsafe(urls::LOCAL_ID.into(), Value::String(identity))?;
                let r = create_genesis(&self.db, r).await?;
                self.db.flush()?;
                r.get_subject().to_string()
            };
            keys.insert(resource.key.clone(), id.clone());
            state.ids.insert(resource.key.clone(), id);
        }
        // Journal the union of previous and next owned properties once for the
        // whole graph. Rewriting an ever-growing ownership map per node is
        // quadratic for large API collections; the union also makes crash replay
        // remove stale values whether a resource save happened or not.
        for spec in &projection.resources {
            let owned = state.properties.entry(spec.key.clone()).or_default();
            owned.extend([urls::PARENT.to_string(), urls::IS_A.to_string()]);
            for pair in &spec.properties {
                owned.push(pair.property.resolve(&keys)?);
            }
            owned.sort();
            owned.dedup();
        }
        self.db
            .kv
            .insert(Tree::PluginMeta, STATE_KEY, &serde_json::to_vec(&state)?)?;
        self.db.flush()?;
        let mut ordered = projection.resources.iter().collect::<Vec<_>>();
        ordered.sort_by_key(|r| rank(r));
        for spec in ordered {
            let id = &keys[&spec.key];
            let mut resource = self.db.get_resource(&id.clone().into()).await?;
            let mut desired = BTreeMap::new();
            desired.insert(
                urls::PARENT.to_string(),
                Value::AtomicUrl(spec.parent.resolve(&keys)?.into()),
            );
            desired.insert(
                urls::IS_A.to_string(),
                subjects(
                    spec.classes
                        .iter()
                        .map(|r| r.resolve(&keys))
                        .collect::<AtomicResult<Vec<_>>>()?,
                ),
            );
            for pair in &spec.properties {
                let property = pair.property.resolve(&keys)?;
                let v = match &pair.value {
                    NativeValue::Resource(r) => Value::AtomicUrl(r.resolve(&keys)?.into()),
                    NativeValue::Resources(rs) => subjects(
                        rs.iter()
                            .map(|r| r.resolve(&keys))
                            .collect::<AtomicResult<Vec<_>>>()?,
                    ),
                    scalar => {
                        let p = self.db.get_resource(&property.clone().into()).await?;
                        let datatype = p.get(urls::DATATYPE_PROP)?.to_string();
                        let scalar = match scalar {
                            NativeValue::String(s) => s.clone(),
                            NativeValue::Integer(n) => n.to_string(),
                            NativeValue::Float(n) => n.to_string(),
                            NativeValue::Boolean(v) => v.to_string(),
                            _ => unreachable!(),
                        };
                        Value::new(&scalar, &match_datatype(&datatype))?
                    }
                };
                desired.insert(property, v);
            }
            let mut dirty = false;
            // Only retire properties previously owned by this projection.
            for old in state.properties.get(&spec.key).into_iter().flatten() {
                if !desired.contains_key(old) && resource.get(old).is_ok() {
                    resource.remove_propval(old)?;
                    dirty = true;
                }
            }
            for (property, v) in &desired {
                if text(&resource, property).as_deref() != Some(&v.to_string()) {
                    resource.set_unsafe(property.clone(), v.clone())?;
                    dirty = true;
                }
            }
            if dirty {
                resource.save(&self.db).await?;
                changed.push(id.clone());
            }
            state
                .properties
                .insert(spec.key.clone(), desired.keys().cloned().collect());
        }
        let absent = state
            .ids
            .iter()
            .filter(|(key, _)| !keys.contains_key(*key))
            .map(|(_, id)| id.clone())
            .collect::<Vec<_>>();
        if !absent.is_empty() {
            let archive = self
                .ensure(
                    "folder",
                    "previous-members",
                    "https://atomicdata.dev/classes/Folder",
                    vec![],
                )
                .await?;
            for id in absent {
                let mut resource = self.db.get_resource(&id.clone().into()).await?;
                if text(&resource, urls::PARENT).as_deref() != Some(&archive) {
                    resource.set_unsafe(
                        urls::PARENT.into(),
                        Value::AtomicUrl(archive.clone().into()),
                    )?;
                    resource.save(&self.db).await?;
                    changed.push(id);
                }
            }
            changed.push(archive);
        }
        self.db
            .kv
            .insert(Tree::PluginMeta, STATE_KEY, &serde_json::to_vec(&state)?)?;
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
        changed.push(self.drive.clone());
        Ok(changed)
    }
}
