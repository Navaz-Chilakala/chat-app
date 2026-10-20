-- Telecom Knowledge AI: initial schema.
-- Conventions: uuid primary keys, timestamptz everywhere, soft references cascade on delete
-- so deleting a document removes its versions, sections, chunks and embeddings.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- identity & tenancy ----------
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  is_admin      boolean NOT NULL DEFAULT false,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('shared','personal','team')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON workspace_memberships(user_id);

-- ---------- sources ----------
CREATE TABLE document_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('3gpp_archive','url','git_repo','upload','bulk_import')),
  name           text NOT NULL,
  url            text,
  authority_tier smallint NOT NULL CHECK (authority_tier BETWEEN 1 AND 4),
  source_type    text NOT NULL,
  trust_level    text NOT NULL DEFAULT 'unverified' CHECK (trust_level IN ('official','trusted','community','unverified')),
  access_method  text NOT NULL DEFAULT 'manual',
  license        text,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled','pending_review','rejected')),
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_interval_hours integer,
  last_synced_at timestamptz,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, url)
);

CREATE TABLE source_sync_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('running','succeeded','failed','partial')),
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX sync_runs_source_idx ON source_sync_runs(source_id, started_at DESC);

CREATE TABLE repository_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   uuid NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
  repo_url    text NOT NULL,
  ref         text NOT NULL,
  commit_sha  text NOT NULL,
  license     text,
  file_count  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, commit_sha)
);

-- ---------- documents ----------
CREATE TABLE documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id      uuid REFERENCES document_sources(id) ON DELETE SET NULL,
  doc_key        text NOT NULL,           -- stable identity, e.g. '3gpp:23.502', 'upload:<sha256>', 'repo:<url>:<path>'
  title          text NOT NULL,
  source_type    text NOT NULL,           -- official_normative | official_informative | official_schema | reference_implementation | vendor | academic | educational | user_provided | unverified
  authority_tier smallint NOT NULL CHECK (authority_tier BETWEEN 1 AND 4),
  spec_number    text,                    -- '23.502'
  spec_type      text CHECK (spec_type IN ('TS','TR')),
  series         text,
  tags           text[] NOT NULL DEFAULT '{}',
  review_status  text NOT NULL DEFAULT 'approved' CHECK (review_status IN ('approved','pending','rejected')),
  current_version_id uuid,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, doc_key)
);
CREATE INDEX documents_spec_idx ON documents(spec_number);
CREATE INDEX documents_ws_idx ON documents(workspace_id, updated_at DESC);

CREATE TABLE document_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_label     text,                 -- '19.4.0' or commit sha
  release           smallint,             -- 3GPP release number
  checksum          text NOT NULL,        -- sha256 of original bytes
  mime_type         text NOT NULL,
  byte_size         bigint NOT NULL,
  original_filename text,
  source_url        text,
  storage_key       text,
  published_at      date,
  retrieved_at      timestamptz NOT NULL DEFAULT now(),
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','indexed','failed','superseded')),
  is_current        boolean NOT NULL DEFAULT false,
  page_count        integer,
  chunk_count       integer NOT NULL DEFAULT 0,
  chunking_strategy text,
  chunker_version   text,
  license           text,
  commit_sha        text,
  repo_path         text,
  language          text,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, checksum)
);
CREATE INDEX versions_doc_idx ON document_versions(document_id, created_at DESC);
CREATE UNIQUE INDEX versions_one_current ON document_versions(document_id) WHERE is_current;
ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) ON DELETE SET NULL;

-- Originals for the 'db' storage driver. Kept separate from derived text.
CREATE TABLE document_blobs (
  storage_key text PRIMARY KEY,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Explicit cross-workspace grants (optional; membership is the default access path).
CREATE TABLE document_permissions (
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  permission   text NOT NULL CHECK (permission IN ('read')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, workspace_id)
);

CREATE TABLE document_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES document_sections(id) ON DELETE CASCADE,
  clause      text,                       -- '5.2.2.2.2'
  heading     text NOT NULL,
  level       smallint NOT NULL,
  ord         integer NOT NULL,
  page_start  integer,
  page_end    integer
);
CREATE INDEX sections_version_idx ON document_sections(version_id, ord);
CREATE INDEX sections_clause_idx ON document_sections(version_id, clause);

CREATE TABLE document_chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id     uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  section_id     uuid REFERENCES document_sections(id) ON DELETE SET NULL,
  ord            integer NOT NULL,
  chunk_type     text NOT NULL,           -- text | table | definition | abbreviation | code | api_operation | api_schema | config
  content        text NOT NULL,
  content_hash   text NOT NULL,
  clause         text,
  heading_path   text,
  page_start     integer,
  page_end       integer,
  symbol         text,
  language       text,
  line_start     integer,
  line_end       integer,
  token_count    integer NOT NULL,
  identifiers    text[] NOT NULL DEFAULT '{}',
  flags          text[] NOT NULL DEFAULT '{}',
  -- denormalised filter columns (kept in sync by the pipeline / approval workflow)
  spec_number    text,
  release        smallint,
  source_type    text NOT NULL,
  authority_tier smallint NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  searchable     boolean NOT NULL DEFAULT false,   -- version indexed AND document approved
  is_current     boolean NOT NULL DEFAULT false,   -- belongs to the document's current version
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  fts            tsvector GENERATED ALWAYS AS (
                   setweight(to_tsvector('simple', coalesce(clause,'') || ' ' || coalesce(heading_path,'') || ' ' || coalesce(symbol,'')), 'A') ||
                   setweight(to_tsvector('english', content), 'B')
                 ) STORED,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chunks_version_idx ON document_chunks(version_id, ord);
CREATE INDEX chunks_fts_idx ON document_chunks USING gin(fts) WHERE searchable;
CREATE INDEX chunks_ident_idx ON document_chunks USING gin(identifiers) WHERE searchable;
CREATE INDEX chunks_filter_idx ON document_chunks(workspace_id, spec_number, release) WHERE searchable;
CREATE INDEX chunks_clause_idx ON document_chunks(spec_number, clause) WHERE searchable;
CREATE INDEX chunks_hash_idx ON document_chunks(content_hash);
CREATE INDEX chunks_doc_idx ON document_chunks(document_id);

-- Abbreviations harvested from ingested documents' "Abbreviations" clauses (evidence-based query expansion).
CREATE TABLE abbreviations (
  abbr         text NOT NULL,
  expansion    text NOT NULL,
  chunk_id     uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (chunk_id, abbr, expansion)
);
CREATE INDEX abbreviations_abbr_idx ON abbreviations(lower(abbr));

-- ---------- embeddings ----------
CREATE TABLE embedding_models (
  id          serial PRIMARY KEY,
  provider    text NOT NULL,
  model       text NOT NULL,
  dimensions  integer NOT NULL CHECK (dimensions BETWEEN 8 AND 4000),
  version     text NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, dimensions, version)
);
CREATE UNIQUE INDEX embedding_models_one_active ON embedding_models((true)) WHERE is_active;

-- Untyped vector column so several models/dimensions can coexist during a controlled re-embed.
-- A per-model partial HNSW index is created by the app (see src/lib/embeddings/index-manager.ts).
CREATE TABLE embeddings (
  chunk_id     uuid NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE,
  model_id     integer NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  embedding    vector NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model_id)
);
CREATE INDEX embeddings_model_idx ON embeddings(model_id);

-- Content-addressed cache: identical text is never embedded twice per model.
CREATE TABLE embedding_cache (
  content_hash text NOT NULL,
  model_id     integer NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  embedding    vector NOT NULL,
  token_count  integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, model_id)
);

CREATE TABLE embedding_usage (
  id          bigserial PRIMARY KEY,
  model_id    integer NOT NULL REFERENCES embedding_models(id) ON DELETE CASCADE,
  job_id      uuid,
  texts       integer NOT NULL,
  tokens      integer NOT NULL,
  cache_hits  integer NOT NULL DEFAULT 0,
  est_cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- structured API / code entities ----------
CREATE TABLE api_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_id      uuid REFERENCES document_chunks(id) ON DELETE SET NULL,
  api_title     text NOT NULL,
  api_version   text,
  openapi_version text,
  method        text NOT NULL,
  path          text NOT NULL,
  operation_id  text,
  summary       text,
  tags          text[] NOT NULL DEFAULT '{}',
  parameters    jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_body  jsonb,
  responses     jsonb NOT NULL DEFAULT '{}'::jsonb,
  security      jsonb,
  servers       jsonb,
  deprecated    boolean NOT NULL DEFAULT false
);
CREATE INDEX api_ops_version_idx ON api_operations(version_id);
CREATE INDEX api_ops_opid_idx ON api_operations(lower(operation_id));
CREATE INDEX api_ops_path_idx ON api_operations(path);

CREATE TABLE api_schemas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_id    uuid REFERENCES document_chunks(id) ON DELETE SET NULL,
  name        text NOT NULL,
  schema      jsonb NOT NULL,
  required    text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX api_schemas_name_idx ON api_schemas(lower(name));
CREATE INDEX api_schemas_version_idx ON api_schemas(version_id);

CREATE TABLE code_symbols (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  chunk_id    uuid REFERENCES document_chunks(id) ON DELETE SET NULL,
  name        text NOT NULL,
  kind        text NOT NULL,
  path        text NOT NULL,
  language    text NOT NULL,
  line_start  integer,
  line_end    integer
);
CREATE INDEX code_symbols_name_idx ON code_symbols(lower(name));

-- ---------- jobs ----------
CREATE TABLE ingestion_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('index_version','fetch_url','sync_source','reembed','delete_document')),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  priority      smallint NOT NULL DEFAULT 5,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_version_id uuid REFERENCES document_versions(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES document_sources(id) ON DELETE CASCADE,
  byte_size     bigint NOT NULL DEFAULT 0,
  attempts      smallint NOT NULL DEFAULT 0,
  max_attempts  smallint NOT NULL DEFAULT 3,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  heartbeat_at  timestamptz,
  stage         text,
  progress      real NOT NULL DEFAULT 0,
  error         text,
  result        jsonb NOT NULL DEFAULT '{}'::jsonb,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX jobs_queue_idx ON ingestion_jobs(priority, run_after) WHERE status = 'queued';
CREATE INDEX jobs_ws_idx ON ingestion_jobs(workspace_id, created_at DESC);
-- Idempotency: at most one live index job per version.
CREATE UNIQUE INDEX jobs_one_live_per_version ON ingestion_jobs(document_version_id)
  WHERE status IN ('queued','running') AND kind = 'index_version';

CREATE TABLE ingestion_job_events (
  id      bigserial PRIMARY KEY,
  job_id  uuid NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  ts      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL CHECK (level IN ('debug','info','warn','error')),
  stage   text,
  message text NOT NULL,
  data    jsonb
);
CREATE INDEX job_events_job_idx ON ingestion_job_events(job_id, id);

-- ---------- conversations ----------
CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_user_idx ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant')),
  content         text NOT NULL,
  answer          jsonb,                 -- structured extractive answer (sections, citations, evidence)
  filters         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages(conversation_id, created_at);

CREATE TABLE retrieval_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  query        text NOT NULL,
  analysis     jsonb NOT NULL,
  results      jsonb NOT NULL,
  latency_ms   integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_events_created_idx ON retrieval_events(created_at DESC);

CREATE TABLE feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

-- ---------- evaluation ----------
CREATE TABLE evaluation_cases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  category    text NOT NULL,
  query       text NOT NULL,
  expected    jsonb NOT NULL,          -- {spec_number?, clause_prefix?, identifiers?, expect_no_answer?}
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics     jsonb NOT NULL DEFAULT '{}'::jsonb,
  results     jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- ---------- governance ----------
CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  data         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_events(created_at DESC);

CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- Defence in depth: deny-by-default RLS on every table. The application connects as the table
-- owner (bypasses RLS) and enforces workspace isolation in its data-access layer; any other role
-- (e.g. Supabase anon/authenticated via PostgREST) sees nothing.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
