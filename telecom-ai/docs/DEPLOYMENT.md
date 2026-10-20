# Deployment

The system has three parts, deployed independently:

1. **Web app** (Next.js) on **Vercel** — UI, API, short-running work. Root directory: `telecom-ai`.
2. **PostgreSQL + pgvector** — Neon or Supabase (both available in the Vercel Marketplace), or any managed Postgres ≥ 15 with `vector`.
3. **Worker** — long-running ingestion (PDF/DOCX parsing, OCR, 3GPP downloads, git clones, embeddings). Run it as a container (`Dockerfile.worker`) **or** with the scheduled GitHub Actions workflow (`.github/workflows/telecom-ai-worker.yml`). A Vercel Cron fallback (`/api/cron/process`) handles only small text/markdown/code/OpenAPI files and URL fetches.

## 1. Database

Vercel → project → **Storage** → **Create Database** → Neon (or Supabase) → connect to the project. This injects `DATABASE_URL`
(use the *pooled* URL for Vercel functions). pgvector is available on both; migrations run `CREATE EXTENSION vector`.

Migrations are applied automatically by `npm run vercel-build` whenever `DATABASE_URL` is set, and by the worker on start
(`AUTO_MIGRATE=false` to disable). Manually: `DATABASE_URL=... npm run db:migrate`, then `npm run db:seed`.

### Sizing the 3GPP corpus (measured)

The local test corpus used **~15 KB per chunk** in total (text, `tsvector`, identifiers, 384-d vector, HNSW and GIN indexes).

| Scope | Rough chunks | Rough size | Fits |
|---|---|---|---|
| ~35 priority specs (`sync:3gpp --priority`) + 3GPP OpenAPI | 40–60k | 0.6–0.9 GB | Neon Free (1 GB) — tight |
| Latest version of every TS/TR, series 21–38 (~2,500 docs) | 400–600k | 5–9 GB | paid Neon/Supabase tier |

These are estimates; check `Knowledge Base → Storage` after a partial sync. Originals of 3GPP zips are **not** stored
(reference + checksum only, re-fetched for re-indexing) unless `THREEGPP_STORE_ORIGINALS=true`.

## 2. Vercel web app

Project settings: Framework **Next.js**, Root Directory **`telecom-ai`**, Build Command `npm run vercel-build` (from `vercel.json`), Node 22.

Environment variables (Production + Preview):

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | pooled Postgres URL (injected by the Neon/Supabase integration) |
| `SESSION_SECRET` | yes | ≥ 32 random characters |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | recommended | bootstrap administrator, created (bcrypt-hashed) on first sign-in if missing; an existing account's password is never overwritten — change it in Settings |
| `CRON_SECRET` | recommended | Vercel Cron sends it as a bearer token to `/api/cron/process` |
| `SIGNUP_MODE` / `ALLOWED_SIGNUP_EMAILS` | recommended | `invite` + comma-separated emails to restrict sign-up (applies to the first account too; the first account becomes admin) |
| `STORAGE_DRIVER` + `S3_*` | optional | `db` (default) stores originals in Postgres; use `s3` for R2/S3/Supabase Storage |
| `EMBEDDING_PROVIDER` + `EMBEDDING_*` | optional | default `local-hash` (offline); `openai-compatible` for a neural endpoint — must match the worker |
| `URL_INGEST_ALLOWED_HOSTS` | optional | restrict URL ingestion to listed hosts |

Without `DATABASE_URL` the deployment builds and serves a `/setup` page listing missing variable *names*.
Health check: `GET /api/health` (200 when DB reachable, pgvector present and migrated).

Vercel Hobby limits cron jobs to once per day (configured at 03:17 UTC); a real worker is required for timely indexing.

## 3. Worker

**Container** (Railway, Fly.io, Render, Cloud Run, ECS, Kubernetes):

```bash
docker build -f Dockerfile.worker -t telecom-worker telecom-ai
docker run -e DATABASE_URL=... -e SESSION_SECRET=... -p 8080:8080 telecom-worker   # GET :8080 = health
```

The worker needs outbound HTTPS to `www.3gpp.org` (3GPP sync), git hosts (repositories) and the embedding endpoint if not
`local-hash`. Env: `WORKER_POLL_MS` (5000), `WORKER_SCHEDULE_SYNCS` (true), `OCR_ENABLED` (true), `OCR_FIGURES` (true),
`OCR_MODEL` (`best`), `OCR_MIN_CONFIDENCE` (60), `OCR_MAX_IMAGES_PER_DOC` (2000). Run several replicas safely — jobs are claimed with `SKIP LOCKED`.

**GitHub Actions** (no server needed): add repository secret `TELECOM_DATABASE_URL`, then *Actions → telecom-ai worker → Run workflow*
with `sync3gpp = priority` (or `all`). The workflow also runs every 6 hours to drain the queue. Each run is capped below GitHub's 6-hour limit;
interrupted jobs are requeued automatically and the next run continues (registered versions are skipped, so syncs are resumable).

## Initial corpus

```bash
npm run sync:3gpp -- --priority            # brief's priority specs first (TS 23.501/502/503, 24.501, 38.413, 29.244, 23.401, …)
npm run sync:3gpp                          # then everything else in series 21–38
```

Activate repositories (Sources page → *Approve / activate* → *Sync now*) after reviewing their licences.

## CI

`.github/workflows/telecom-ai-ci.yml` runs typecheck, all tests against `pgvector/pgvector:pg16`, and a production build on every change under `telecom-ai/`.

## Backups, monitoring, rollback

- **Backups**: enable provider point-in-time recovery (Neon branches / Supabase PITR). Logical backup: `pg_dump --format=custom "$DATABASE_URL" > telecom.dump`; restore with `pg_restore --clean --no-owner -d "$DATABASE_URL" telecom.dump`. Originals in S3 should use bucket versioning.
- **Monitoring**: structured JSON logs (`level`, `msg`, `jobId`, `requestId`) from web and worker; `/api/health`; worker health port; Knowledge Base dashboard (queue, failed jobs, index health, OCR, storage, embedding cost); `retrieval_events` table for query latency and channel diagnostics.
- **Rollback**: web — Vercel *Instant Rollback* to the previous deployment. Schema — migrations are additive; restore from a provider branch/PITR if a migration must be undone. Embeddings — switching models never overwrites vectors; re-activate the previous model in Settings. Document versions — previous versions remain in history.
