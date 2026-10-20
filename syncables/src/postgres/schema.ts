export const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS syncables_cache;
CREATE TABLE IF NOT EXISTS syncables_cache.version (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL
);
INSERT INTO syncables_cache.version VALUES(true,1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS syncables_cache.device_login_required (
  owner text NOT NULL, issuer text NOT NULL, client_id text NOT NULL,
  since timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner,issuer,client_id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.payloads (
  owner text NOT NULL, hash text NOT NULL, codec text NOT NULL,
  raw_bytes integer NOT NULL CHECK(raw_bytes >= 0), data bytea NOT NULL,
  PRIMARY KEY(owner,hash)
);
CREATE TABLE IF NOT EXISTS syncables_cache.runs (
  owner text NOT NULL, id uuid NOT NULL, connection text NOT NULL,
  authorization_context text NOT NULL, reason text NOT NULL,
  state text NOT NULL DEFAULT 'recording' CHECK(state IN ('recording','complete','failed')),
  next_sequence integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  PRIMARY KEY(owner,id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.attempts (
  owner text NOT NULL, id uuid NOT NULL, run uuid NOT NULL, sequence integer NOT NULL,
  ordinal bigserial NOT NULL, connection text NOT NULL, authorization_context text NOT NULL,
  request_key text NOT NULL, cache_key text NOT NULL, request_url text NOT NULL,
  request jsonb NOT NULL, outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','response','error')),
  origin text CHECK(origin IN ('upstream','cache')), source_attempt uuid,
  status integer, headers jsonb, payload_hash text, effective_payload_hash text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), observed_at timestamptz,
  PRIMARY KEY(owner,id), UNIQUE(owner,run,sequence),
  FOREIGN KEY(owner,run) REFERENCES syncables_cache.runs(owner,id),
  FOREIGN KEY(owner,payload_hash) REFERENCES syncables_cache.payloads(owner,hash),
  FOREIGN KEY(owner,effective_payload_hash) REFERENCES syncables_cache.payloads(owner,hash),
  FOREIGN KEY(owner,source_attempt) REFERENCES syncables_cache.attempts(owner,id)
);
CREATE INDEX IF NOT EXISTS attempts_url ON syncables_cache.attempts(owner,connection,request_url);
CREATE TABLE IF NOT EXISTS syncables_cache.heads (
  owner text NOT NULL, connection text NOT NULL, authorization_context text NOT NULL,
  cache_key text NOT NULL, attempt uuid NOT NULL, ordinal bigint NOT NULL,
  PRIMARY KEY(owner,connection,authorization_context,cache_key),
  FOREIGN KEY(owner,attempt) REFERENCES syncables_cache.attempts(owner,id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.leases (
  owner text NOT NULL, connection text NOT NULL, authorization_context text NOT NULL,
  request_key text NOT NULL, token uuid NOT NULL, expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner,connection,authorization_context,request_key)
);
CREATE TABLE IF NOT EXISTS syncables_cache.json_nodes (
  owner text NOT NULL, hash text NOT NULL, codec text NOT NULL,
  raw_bytes integer NOT NULL CHECK(raw_bytes >= 0), data bytea NOT NULL,
  PRIMARY KEY(owner,hash)
);
CREATE TABLE IF NOT EXISTS syncables_cache.json_responses (
  owner text NOT NULL, attempt uuid NOT NULL, root_hash text, indexing_error text,
  encoding_version integer NOT NULL DEFAULT 1 CHECK(encoding_version=1),
  PRIMARY KEY(owner,attempt),
  FOREIGN KEY(owner,attempt) REFERENCES syncables_cache.attempts(owner,id) ON DELETE CASCADE,
  FOREIGN KEY(owner,root_hash) REFERENCES syncables_cache.json_nodes(owner,hash),
  CHECK((root_hash IS NULL) <> (indexing_error IS NULL))
);
`;
