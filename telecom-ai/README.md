# Telecom Knowledge AI

Evidence-grounded retrieval over **3GPP specifications (LTE/EPC, 5G NR, 5G Core)**, OpenAPI service definitions,
open-source telecom code and your own engineering documents.

**No LLM is used anywhere.** Answers are *extractive*: every statement is a verbatim quote from an indexed source,
with a citation to the specification, version, release, clause and page (or repository, commit, path and lines).
When the knowledge base has no supporting text, the answer says **"Insufficient evidence"** instead of guessing.

| Capability | How |
|---|---|
| Ingestion | PDF, DOCX, legacy DOC, 3GPP zip deliverables, HTML, Markdown, text, CSV, OpenAPI/JSON/YAML, ASN.1, source code, URLs, git repositories |
| OCR | Tesseract (WASM, bundled "best" English model): scanned PDF pages and raster figures (call-flow diagrams); confidence stored, low-confidence text flagged and down-ranked |
| Chunking | 3GPP clause hierarchy (heading paths, definitions, abbreviations, tables + captions, figures, notes), symbol-aware code, structural OpenAPI (operations/schemas) |
| Retrieval | Hybrid: exact clause lookup, telecom identifier match (messages, IEs, timers, interfaces, SBI operations, causes), IDF-weighted full-text, pgvector cosine; weighted RRF fusion; authority priors; parent-section expansion |
| Answers | Verbatim quotes, normative statements, procedure steps, failure cases, identifiers, tables, OCR figures, code references, API operations, version-conflict and evidence-gap notices |
| Call flows | Mermaid diagrams parsed from the numbered stage-2 steps of the retrieved clause; curated flows verified step-by-step against the indexed clause |
| API tooling | OpenAPI validator, JSON-Schema payload validation, deterministic TypeScript/Python/FastAPI/Go code generation |
| Governance | Accounts, workspaces, review queue for shared uploads, audit log, rate limits, SSRF-safe fetching, robots.txt, deny-by-default RLS |

## Quick start (local)

Requirements: Node 20.9+ (22 recommended), PostgreSQL 15+ with the `vector` extension (pgvector ≥ 0.5), `git` (for repository ingestion).

```bash
cd telecom-ai
npm install
cp .env.example .env            # set DATABASE_URL and SESSION_SECRET (≥ 32 chars)
npm run db:seed                 # migrations + Commons workspace + source registry + eval cases
npm run dev                     # web app on http://localhost:3000 (first account = admin, or set ADMIN_USERNAME/ADMIN_PASSWORD)
npm run worker                  # background worker (separate terminal) — indexes uploads, syncs sources
```

Useful commands:

```bash
npm run ingest:file -- path/to/spec.docx --source-type official_normative   # index files from the CLI
npm run sync:3gpp -- --priority          # download + index the ~35 priority 3GPP specs (needs access to www.3gpp.org)
npm run sync:3gpp                        # latest version of every TS/TR in series 21–38 (large: see docs/DEPLOYMENT.md)
npm run worker -- --once                 # drain the queue and exit
npm run eval                             # retrieval/answer evaluation against the indexed corpus
npm run typecheck && npm test            # strict TypeScript + unit/integration tests (needs a test database)
npm run build                            # production build
```

Tests use `TEST_DATABASE_URL` (default `postgres://telecom:telecom@127.0.0.1:5432/telecom_ai_test`) and never touch the main database.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, data model, ingestion lifecycle, retrieval and answer pipeline, security model
- [docs/API.md](docs/API.md) — HTTP API reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Vercel, database, worker, 3GPP corpus sizing, backups, monitoring, rollback
- [docs/STATUS.md](docs/STATUS.md) — what is verified, actual test/evaluation results, known limitations and roadmap

## Source authority

| Tier | Source types | Examples |
|---|---|---|
| 1 | Official normative / informative 3GPP deliverables | TS 23.501, TS 23.502, TS 24.501, TS 38.413 … (from the official archive) |
| 2 | Official schemas, other SDOs | 3GPP OpenAPI YAML, IETF RFCs, ITU-T |
| 3 | Reference implementations, vendor docs | Open5GS, free5GC, UERANSIM, srsRAN, OAI |
| 4 | Academic, educational, user-provided, unverified | articles, papers, lab notes |

Tier is shown on every citation and used as a ranking prior; only admins can label uploads as Tier 1/2.
3GPP documents are © ARIB, ATIS, CCSA, ETSI, TSDSI, TTA, TTC. This app stores them for internal reference and quotes short passages with citations; do not republish whole specifications.
