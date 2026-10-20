# HTTP API

All endpoints are under `/api`, JSON in/out, authenticated by the `tk_session` cookie unless noted.
Mutating requests must include an `Origin` header matching the host. Errors: `{ "error": string, "requestId": string, "issues"?: [...] }`.

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/signup` | `{email, password (≥10), displayName}` | First user becomes admin. `SIGNUP_MODE=invite` restricts emails. |
| POST | `/auth/login` | `{email, password}` | Sets session cookie. Rate-limited. |
| POST | `/auth/logout` | – | |
| GET | `/auth/me` | – | `{user, workspaces[]}` |

## Asking and searching
| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/chat` | `{message, conversationId?, workspaceIds?, filters?: {specNumbers?, releases?, sourceTypes?, maxTier?, tags?, mode?: latest\|historical\|auto}}` | NDJSON stream: `meta` → `evidence` → `answer` (`{status, confidence, summary[], sections[], compare, flow, apiOperations[], gaps[], conflicts[], evidence[], notice}`) → `done` |
| GET | `/conversations` · `/conversations/{id}` | – | history; `DELETE /conversations/{id}` |
| POST | `/feedback` | `{messageId, rating: 1\|-1, comment?}` | |
| POST | `/search` | `{query, topK?, filters? (+chunkTypes)}` | raw hybrid results with analysis, channel counts, expansions, gaps, unknown terms |
| GET | `/chunks/{id}` | – | citation viewer: chunk + provenance + clause siblings |

## Documents and ingestion
| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/documents` | `q, sourceType, review, tag, sourceId, limit, offset` | |
| POST | `/documents/upload` | multipart: `workspaceId`, `sourceType`, `files[]` (≤ 50) | per-file result: `{ok, duplicate, documentId, versionId, jobId, reviewStatus}` |
| GET | `/documents/{id}` | `version?` | document, versions (warnings, checksum, provenance), section tree, jobs |
| DELETE | `/documents/{id}` | – | hides immediately, deletes in background (chunks, embeddings, originals) |
| POST | `/documents/{id}/review` | `{status: approved\|rejected}` | owner/admin |
| GET | `/documents/{id}/original` | `version?` | authorised download (or redirect to the official source for reference-only versions) |
| GET | `/documents/{id}/sections/{sectionId}` | – | first chunk of a section |
| POST | `/urls` | `{urls[], workspaceId, sourceType}` | queues `fetch_url` jobs (SSRF checks) |
| GET | `/jobs` · `/jobs/{id}` | `status?` | jobs with counts; job detail with event log |
| POST | `/jobs/{id}/retry` · `/jobs/{id}/cancel` | – | |
| GET | `/stats` | – | knowledge-base dashboard (all live queries) |

## Sources (admin for writes)
| Method | Path | Body |
|---|---|---|
| GET | `/sources` | – |
| POST | `/sources` | `{kind: url\|git_repo\|3gpp_archive, name, url, sourceType, trustLevel?, license?, syncIntervalHours?, config?}` (created paused) |
| PATCH | `/sources/{id}` | `{status?: active\|paused\|disabled\|rejected, syncIntervalHours?, config?}` |
| POST | `/sources/{id}/sync` | – (queues `sync_source`) |

## Telecom tooling
| Method | Path | Body / query |
|---|---|---|
| GET | `/flows` | curated flows with verification status |
| POST | `/flows/build` | `{query?} \| {flowId?}` → `{evidenceFlow, curatedFlow, evidence, gaps}` |
| GET | `/api-ops` | `q` (operationId/path/title/tag), `status`, `method` |
| GET | `/api-ops/{id}` | operation + referenced schemas |
| POST | `/codegen` | `{versionId, operationIds?, target: typescript-client\|python-client\|python-fastapi\|go-structs}` → `{files[], provenance, verification}` |
| POST | `/validate` | `{kind: openapi, document}` · `{kind: instance, document, schemaName, instance}` · `{kind: json\|yaml, document}` |
| GET | `/code/symbols` | `q` |

## Admin and operations
| Method | Path | Notes |
|---|---|---|
| GET/POST | `/eval` | list cases/runs; run evaluation (admin) |
| GET/POST | `/settings/embeddings` | models, coverage, OCR config; `{action: reembed}` or `{action: activate, modelId}` (admin) |
| GET/PATCH | `/admin/users` | `{userId, isAdmin?, disabled?, commonsRole?}` |
| GET | `/admin/audit` | |
| GET | `/health` | no auth; `{ok, env, database, pgvector, migrated, queue}` (503 when not ready) |
| GET | `/cron/process` | `Authorization: Bearer $CRON_SECRET`; processes small, light jobs only |
