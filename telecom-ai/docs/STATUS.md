# Status, verification and known limitations

_Last updated: 2026-10-20._

## Verified in the development environment

| Check | Result |
|---|---|
| `npm run typecheck` (strict TS) | pass |
| `npm test` — 44 tests (unit + integration on Postgres 16 + pgvector 0.6) | **44/44 pass** |
| `npm run build` (Next.js 16 production build) | pass |
| Browser end-to-end (Playwright, production server + worker) | sign-up → upload (duplicate detected, Markdown indexed by worker) → chat answer with citations → citation drawer → insufficient-evidence answer → dashboard → jobs → mobile layout: **pass** |
| Repository ingestion | UERANSIM @ `4f45e18f80b0` (4,289 files; generated asn1c code flagged) and 3GPP Rel-18 OpenAPI YAMLs via the GitHub mirror `jdegre/5GC_APIs` @ `117674b61cd9` (337 files, 1,618 operations, 5,369 schemas) |
| Incremental re-sync | re-sync of UERANSIM: 293 new files indexed, 3,996 unchanged files skipped by checksum |
| OCR | embedded call-flow figure: all message labels recovered (one character error); scanned PDF page: clause, message and timer recovered and searchable |

Integration tests cover: durable indexing with cover metadata, duplicate detection, version history and superseding,
embedding reuse for unchanged text, scanned-PDF OCR, safe retry after a transient storage failure (no duplicate chunks),
deletion cascade (chunks, embeddings, original), verbatim-citation faithfulness, exact clause and identifier search,
refusal for unknown terms, unindexed-spec gaps, workspace isolation, and review-queue gating.

## Evaluation (`npm run eval`, local corpus)

The curated cases target official 3GPP specs. **The 3GPP archive (`www.3gpp.org`, `forge.3gpp.org`) was blocked by the
development sandbox's network policy**, so 12 of 15 cases were *skipped (spec not indexed)* — they are not counted as passes.

| Metric (3 evaluable cases) | Value |
|---|---|
| Recall@5 / Recall@10 | 1.0 / 1.0 |
| MRR / nDCG@10 | 1.0 / 1.0 |
| Citation faithfulness (quotes found verbatim in cited source) | 1.0 |
| Refusal accuracy (unanswerable + prompt injection) | 1.0 |
| Mean latency | ~95 ms |

These numbers come from a tiny evaluable set and say little about quality on the real 3GPP corpus. Re-run `npm run eval`
after `npm run sync:3gpp -- --priority` for meaningful figures.

## Deployment status

| Item | Status |
|---|---|
| GitHub | branch `claude/serene-dijkstra-kstf1h` pushed |
| Vercel project | `telecom-knowledge-ai` (Root Directory `telecom-ai`) created; production deployment `dpl_5TWhWEZX7CrpG3rSHj4WP8krteo3` **READY** at https://telecom-knowledge-ai.vercel.app |
| Env vars set | `SESSION_SECRET`, `CRON_SECRET`, `SIGNUP_MODE=invite`, `ALLOWED_SIGNUP_EMAILS`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` |
| Database | **not yet connected** — create a Neon (or Supabase) database in the Vercel project's Storage tab and redeploy; until then the app serves `/setup` |
| Worker | not deployed — use the GitHub Actions workflow (secret `TELECOM_DATABASE_URL`) or `Dockerfile.worker` |
| Deployed-page verification | **not performed from the build environment** (its network policy blocks `*.vercel.app`, and the Vercel connection lacked log/bypass permissions for the team scope). Verify with `GET /api/health` after connecting the database. |
| Deployment Protection | Vercel Authentication is enabled on the project by default; disable it (Settings → Deployment Protection) to make the app's own login page publicly reachable |

## Known limitations

- **3GPP corpus not yet downloaded**: the sync code (listing parser, robots.txt, version selection, checksum-verified
  downloads, priority ordering, resumability) is unit-tested against fixtures but has not run against the live archive.
  It must run from a worker with access to `www.3gpp.org` (container, GitHub Actions workflow, or a session where the host is allowed).
- **Database size**: the full latest-per-spec corpus (est. 5–9 GB) exceeds free Neon/Supabase tiers; see DEPLOYMENT.md.
- **Embeddings**: the default `local-hash` model is lexical (feature hashing), not semantic. Paraphrased questions with no
  shared vocabulary may be missed; exact identifiers, clause lookup and IDF-weighted full text compensate. Configure an
  OpenAI-compatible neural endpoint and run *Re-embed* for semantic recall (no LLM is involved either way).
- **Extractive only**: answers quote sources; they do not paraphrase or synthesise across documents. Multi-document
  synthesis is presented as side-by-side quotes, not as prose.
- **OCR**: English Tesseract only; vector figures (EMF/WMF, common in 3GPP DOCX) cannot be rasterised and are reported
  as skipped; OCR output can contain character errors and is always labelled machine-extracted.
- **Legacy `.doc`** deliverables: text and inferred headings only (tables flattened).
- **Code intelligence** is symbol- and identifier-based (regex symbol detection, no full parser or call graph);
  code↔spec correspondence is reported as evidence, never as compliance.
- **Generated code** (TypeScript/Python/FastAPI/Go) is template-based and type-checked in tests for the fixture schema;
  it is not compiled or executed on the server for arbitrary schemas.
- **Cron fallback** on Vercel Hobby runs once a day and only for small, light files.
- **Release diffs**: different versions are labelled and never merged, but there is no clause-level diff view yet.

## Roadmap

Clause-level release diff viewer; halfvec storage to halve vector size; optional neural reranker endpoint; tree-sitter
code parsing with call graphs; per-document ACL sharing UI; OCR language packs; ETSI-hosted deliverable mirror support;
IETF RFC and GSMA connectors.
