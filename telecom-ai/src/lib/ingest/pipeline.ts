import type pg from "pg";
import { query, queryOne, tx, vacuum } from "../db";
import { storage } from "../storage";
import { processFile } from "./process";
import { CHUNKER_VERSION, type ChunkResult } from "./types";
import { sha256 } from "./hash";
import { enqueueJob, heartbeat, jobEvent, type JobRow } from "./queue";
import { embeddingProvider, ensureEmbeddingModel, toVectorLiteral } from "../embeddings";
import { compareVersions, parseCover, tagsForSpec } from "../telecom/spec";
import { safeFetch } from "../security/ssrf";
import { logger } from "../logger";

export class CancelledError extends Error {}
export class PermanentError extends Error {}

interface VersionRow {
  id: string;
  document_id: string;
  workspace_id: string;
  version_label: string | null;
  release: number | null;
  storage_key: string | null;
  source_url: string | null;
  original_filename: string | null;
  checksum: string;
  commit_sha: string | null;
  repo_path: string | null;
  doc_key: string;
  title: string;
  spec_number: string | null;
  source_type: string;
  authority_tier: number;
  review_status: string;
  tags: string[];
  repo_url: string | null;
}

const INSERT_BATCH = 400;
const EMBED_BATCH = 64;
const MAX_EMBED_CHARS = 8000;

async function stage(job: JobRow, name: string, progress: number, message?: string) {
  const { cancel } = await heartbeat(job.id, name, progress);
  if (message) await jobEvent(job.id, "info", name, message);
  if (cancel) throw new CancelledError("Cancelled by user");
}

async function loadBytes(v: VersionRow): Promise<Buffer> {
  if (v.storage_key) return storage().get(v.storage_key);
  if (v.source_url) {
    // Reference-stored sources (e.g. the 3GPP archive) are re-fetched and checksum-verified.
    const res = await safeFetch(v.source_url, { maxBytes: 300 * 1024 * 1024, timeoutMs: 300_000 });
    if (res.status !== 200) throw new Error(`Source download failed: HTTP ${res.status}`);
    const sum = sha256(res.body);
    if (sum !== v.checksum) throw new PermanentError(`Checksum mismatch for ${v.source_url}: source changed since registration (expected ${v.checksum.slice(0, 12)}…, got ${sum.slice(0, 12)}…)`);
    return res.body;
  }
  throw new PermanentError("Version has neither stored original nor source URL");
}

/**
 * Re-index current zip deliverables (3GPP specs) that were built by an older chunker, so extraction fixes
 * reach documents whose original has not changed. Idempotent: at most one live job per version.
 */
export async function enqueueStaleReindex(): Promise<number> {
  const rows = await query<{ id: string; workspace_id: string; byte_size: number | null }>(
    `SELECT v.id, d.workspace_id, v.byte_size FROM document_versions v JOIN documents d ON d.id = v.document_id
     WHERE v.is_current AND v.status = 'indexed' AND v.original_filename ILIKE '%.zip'
       AND v.chunker_version IS DISTINCT FROM $1
       AND NOT EXISTS (SELECT 1 FROM ingestion_jobs j WHERE j.document_version_id = v.id AND j.status IN ('queued','running'))`,
    [CHUNKER_VERSION],
  );
  for (const r of rows) {
    await enqueueJob({ workspaceId: r.workspace_id, kind: "index_version", documentVersionId: r.id, byteSize: r.byte_size ?? 0, priority: 3 });
  }
  if (rows.length) logger.info("ingest.stale_reindex_queued", { count: rows.length, chunkerVersion: CHUNKER_VERSION });
  return rows.length;
}

export async function indexVersion(job: JobRow): Promise<Record<string, unknown>> {
  const versionId = job.document_version_id;
  if (!versionId) throw new PermanentError("index_version job without document_version_id");
  const v = await queryOne<VersionRow>(
    `SELECT v.id, v.document_id, d.workspace_id, v.version_label, v.release, v.storage_key, v.source_url, v.original_filename, v.checksum,
            v.commit_sha, v.repo_path, d.doc_key, d.title, d.spec_number, d.source_type, d.authority_tier, d.review_status, d.tags,
            s.url AS repo_url
     FROM document_versions v JOIN documents d ON d.id = v.document_id LEFT JOIN document_sources s ON s.id = d.source_id
     WHERE v.id = $1`,
    [versionId],
  );
  if (!v) throw new PermanentError("Document version no longer exists");
  await query("UPDATE document_versions SET status = 'processing' WHERE id = $1", [v.id]);

  await stage(job, "fetch", 0.05, "Loading original document");
  const bytes = await loadBytes(v);

  await stage(job, "extract", 0.1, `Extracting text (${(bytes.length / 1024).toFixed(0)} KiB)`);
  const isSpec = v.doc_key.startsWith("3gpp:");
  const docLabel = v.spec_number ? `${v.title.match(/\b(TS|TR)\b/)?.[0] ?? "TS"} ${v.spec_number}` : undefined;
  const t0 = Date.now();
  const out = await processFile(bytes, v.repo_path ?? v.original_filename ?? "document", {
    docLabel,
    repo: v.repo_url,
    commit: v.commit_sha,
  });
  const result: ChunkResult = out.result;
  await jobEvent(job.id, "info", "extract", `Format ${out.format}${out.innerFilename ? ` (${out.innerFilename})` : ""}; ${result.sections.length} sections, ${result.chunks.length} chunks via ${result.strategy} in ${Date.now() - t0} ms`, {
    pageCount: out.pageCount,
    ocr: out.extracted?.ocrStats ?? null,
  });
  for (const w of result.warnings) await jobEvent(job.id, "warn", "extract", w);

  // 3GPP cover metadata is authoritative over filename-derived metadata.
  let title = v.title;
  let versionLabel = v.version_label;
  let release = v.release;
  let publishedAt: string | null = null;
  let specType: string | null = null;
  const metaWarnings = [...result.warnings];
  if (out.extracted) {
    const cover = parseCover(out.extracted.head);
    if (cover) {
      if (v.spec_number && cover.specNumber !== v.spec_number) {
        metaWarnings.push(`Cover page says ${cover.specType} ${cover.specNumber} but the file was registered as ${v.spec_number}`);
        await jobEvent(job.id, "warn", "metadata", metaWarnings[metaWarnings.length - 1]!);
      }
      if (versionLabel && cover.version !== versionLabel) {
        metaWarnings.push(`Cover version V${cover.version} differs from filename version ${versionLabel}; using cover version`);
      }
      versionLabel = cover.version;
      release = cover.release ?? release;
      publishedAt = cover.date ? `${cover.date}-01` : null;
      specType = cover.specType;
      if (cover.title) title = `3GPP ${cover.specType} ${cover.specNumber}: ${cover.title}`;
    } else if (isSpec) {
      metaWarnings.push("3GPP cover block not found; title/version derived from filename only");
    }
  }
  if (!result.chunks.length) throw new PermanentError("No extractable content (empty document, unsupported layout, or OCR found no text)");

  await stage(job, "persist", 0.35, "Writing sections and chunks");
  const searchable = v.review_status === "approved";
  // A document uploaded under a non-3GPP filename still gets its spec identity from the cover page.
  const coverSpec = out.extracted ? parseCover(out.extracted.head) : null;
  const specNumber = v.spec_number ?? coverSpec?.specNumber ?? null;
  if (!v.spec_number && coverSpec) {
    await query("UPDATE documents SET spec_number = $2, spec_type = $3, series = $4 WHERE id = $1", [v.document_id, coverSpec.specNumber, coverSpec.specType, coverSpec.specNumber.slice(0, 2)]);
  }
  const tags = [...new Set([...(v.tags ?? []), ...tagsForSpec(specNumber, title)])];
  const docIdents = specNumber ? [`spec:${specNumber}`] : [];
  const replacing = !!(await queryOne("SELECT 1 FROM document_chunks WHERE version_id = $1 LIMIT 1", [v.id]));
  const chunkIds = await tx(async (client) => {
    // Idempotent retry: clear anything a previous failed attempt wrote for this version.
    await query("DELETE FROM document_sections WHERE version_id = $1", [v.id], client);
    await query("DELETE FROM document_chunks WHERE version_id = $1", [v.id], client);
    const sectionIds = new Map<string, string>();
    for (const s of result.sections) {
      const row = await queryOne<{ id: string }>(
        "INSERT INTO document_sections(version_id, parent_id, clause, heading, level, ord, page_start, page_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [v.id, s.parentKey ? (sectionIds.get(s.parentKey) ?? null) : null, s.clause, s.heading.slice(0, 1000), s.level, s.ord, s.pageStart, s.pageEnd],
        client,
      );
      sectionIds.set(s.key, row!.id);
    }
    const ids: string[] = new Array(result.chunks.length);
    const indexByOrd = new Map(result.chunks.map((c, i) => [c.ord, i]));
    for (let i = 0; i < result.chunks.length; i += INSERT_BATCH) {
      const batch = result.chunks.slice(i, i + INSERT_BATCH).map((c) => ({
        ord: c.ord,
        chunk_type: c.chunkType,
        content: c.content,
        content_hash: sha256(`${c.headingPath ?? ""}\n${c.content}`),
        section_id: c.sectionKey ? (sectionIds.get(c.sectionKey) ?? null) : null,
        clause: c.clause,
        heading_path: c.headingPath,
        page_start: c.pageStart,
        page_end: c.pageEnd,
        symbol: c.symbol,
        language: c.language,
        line_start: c.lineStart,
        line_end: c.lineEnd,
        token_count: c.tokenCount,
        identifiers: [...new Set([...c.identifiers, ...docIdents])],
        flags: c.flags,
        metadata: c.metadata,
      }));
      const rows = await query<{ id: string; ord: number }>(
        `INSERT INTO document_chunks(version_id, document_id, workspace_id, section_id, ord, chunk_type, content, content_hash, clause, heading_path,
            page_start, page_end, symbol, language, line_start, line_end, token_count, identifiers, flags, spec_number, release, source_type,
            authority_tier, tags, searchable, is_current, metadata)
         SELECT $1, $2, $3, x.section_id, x.ord, x.chunk_type, x.content, x.content_hash, x.clause, x.heading_path, x.page_start, x.page_end,
                x.symbol, x.language, x.line_start, x.line_end, x.token_count, x.identifiers, x.flags, $5, $6, $7, $8, $9, false, false, x.metadata
         FROM jsonb_to_recordset($4::jsonb) AS x(ord int, chunk_type text, content text, content_hash text, section_id uuid, clause text,
              heading_path text, page_start int, page_end int, symbol text, language text, line_start int, line_end int, token_count int,
              identifiers text[], flags text[], metadata jsonb)
         RETURNING id, ord`,
        [v.id, v.document_id, v.workspace_id, JSON.stringify(batch), specNumber, release, v.source_type, v.authority_tier, tags],
        client,
      );
      for (const r of rows) ids[indexByOrd.get(r.ord)!] = r.id;
    }
    const idByOrd = new Map(result.chunks.map((c, i) => [c.ord, ids[i]!]));
    for (const op of result.apiOperations ?? []) {
      await query(
        `INSERT INTO api_operations(version_id, chunk_id, api_title, api_version, openapi_version, method, path, operation_id, summary, tags, parameters, request_body, responses, security, servers, deprecated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [v.id, idByOrd.get(op.chunkOrd), op.apiTitle, op.apiVersion, op.openapiVersion, op.method, op.path, op.operationId, op.summary, op.tags,
         JSON.stringify(op.parameters), op.requestBody ? JSON.stringify(op.requestBody) : null, JSON.stringify(op.responses), op.security ? JSON.stringify(op.security) : null,
         op.servers ? JSON.stringify(op.servers) : null, op.deprecated],
        client,
      );
    }
    for (const s of result.apiSchemas ?? []) {
      await query("INSERT INTO api_schemas(version_id, chunk_id, name, schema, required) VALUES ($1,$2,$3,$4,$5)", [v.id, idByOrd.get(s.chunkOrd), s.name, JSON.stringify(s.schema), s.required], client);
    }
    for (const s of result.codeSymbols ?? []) {
      await query(
        "INSERT INTO code_symbols(version_id, chunk_id, name, kind, path, language, line_start, line_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [v.id, idByOrd.get(s.chunkOrd), s.name, s.kind, s.path, s.language, s.lineStart, s.lineEnd],
        client,
      );
    }
    for (const a of result.abbreviations ?? []) {
      await query("INSERT INTO abbreviations(abbr, expansion, chunk_id, workspace_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [a.abbr, a.expansion.slice(0, 300), idByOrd.get(a.chunkOrd), v.workspace_id], client);
    }
    return ids;
  });

  // ---- embeddings (content-hash cache for remote providers: unchanged text is never re-embedded) ----
  const provider = embeddingProvider();
  const modelId = await ensureEmbeddingModel(provider);
  const texts = result.chunks.map((c) => `${c.headingPath ?? ""}\n${c.content}`.slice(0, MAX_EMBED_CHARS));
  const hashes = result.chunks.map((c) => sha256(`${c.headingPath ?? ""}\n${c.content}`));
  const cached = new Map<string, string>();
  for (let i = 0; provider.cacheable && i < hashes.length; i += 1000) {
    const rows = await query<{ content_hash: string; embedding: string }>(
      "SELECT content_hash, embedding::text AS embedding FROM embedding_cache WHERE model_id = $1 AND content_hash = ANY($2)",
      [modelId, hashes.slice(i, i + 1000)],
    );
    for (const r of rows) cached.set(r.content_hash, r.embedding);
  }
  const toEmbed = [...new Set(hashes.filter((h) => !cached.has(h)))];
  let tokens = 0;
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const batchHashes = toEmbed.slice(i, i + EMBED_BATCH);
    const batchTexts = batchHashes.map((h) => texts[hashes.indexOf(h)]!);
    const { vectors, tokens: t } = await provider.embed(batchTexts);
    tokens += t;
    const payload = batchHashes.map((h, k) => ({ h, v: toVectorLiteral(vectors[k]!), t: Math.ceil(batchTexts[k]!.length / 4) }));
    if (provider.cacheable) await query(
      `INSERT INTO embedding_cache(content_hash, model_id, embedding, token_count)
       SELECT x.h, $1, x.v::vector, x.t FROM jsonb_to_recordset($2::jsonb) AS x(h text, v text, t int) ON CONFLICT DO NOTHING`,
      [modelId, JSON.stringify(payload)],
    );
    for (const p of payload) cached.set(p.h, p.v);
    await stage(job, "embed", 0.45 + 0.4 * ((i + EMBED_BATCH) / Math.max(1, toEmbed.length)));
  }
  await jobEvent(job.id, "info", "embed", `Embeddings: ${toEmbed.length} computed, ${hashes.length - toEmbed.length} reused from cache (${provider.provider}/${provider.model}, ${provider.dimensions}d)`);
  for (let i = 0; i < chunkIds.length; i += 500) {
    const payload = chunkIds.slice(i, i + 500).map((id, k) => ({ id, v: cached.get(hashes[i + k]!)! }));
    await query(
      `INSERT INTO embeddings(chunk_id, model_id, embedding) SELECT x.id, $1, x.v::vector FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, v text)
       ON CONFLICT (chunk_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
      [modelId, JSON.stringify(payload)],
    );
  }
  await query("INSERT INTO embedding_usage(model_id, job_id, texts, tokens, cache_hits, est_cost_usd) VALUES ($1,$2,$3,$4,$5,$6)", [
    modelId, job.id, toEmbed.length, tokens, hashes.length - toEmbed.length, (tokens / 1e6) * provider.costPer1MTokens,
  ]);

  // ---- quality checks: never activate an incomplete index ----
  await stage(job, "verify", 0.9, "Running ingestion quality checks");
  const check = await queryOne<{ chunks: number; embedded: number }>(
    `SELECT count(*)::int AS chunks, count(e.chunk_id)::int AS embedded FROM document_chunks c
     LEFT JOIN embeddings e ON e.chunk_id = c.id AND e.model_id = $2 WHERE c.version_id = $1`,
    [v.id, modelId],
  );
  if (!check || check.chunks !== result.chunks.length) throw new Error(`Quality check failed: expected ${result.chunks.length} chunks, found ${check?.chunks}`);
  if (check.embedded !== check.chunks) throw new Error(`Quality check failed: ${check.chunks - check.embedded} chunk(s) missing embeddings`);
  const lowOcr = result.chunks.filter((c) => c.flags.includes("ocr_low_confidence")).length;
  if (lowOcr) metaWarnings.push(`${lowOcr} OCR chunk(s) below the confidence threshold are indexed but down-ranked`);

  // ---- activate ----
  await stage(job, "activate", 0.95);
  await tx(async (client: pg.PoolClient) => {
    const cur = await queryOne<{ id: string; version_label: string | null; created_at: Date }>(
      "SELECT id, version_label, created_at FROM document_versions WHERE document_id = $1 AND is_current FOR UPDATE",
      [v.document_id],
      client,
    );
    // An older spec version indexed later (historical ingestion) must not displace the current one.
    const becomesCurrent = !cur || cur.id === v.id || !(isSpec && cur.version_label && versionLabel && compareVersions(versionLabel, cur.version_label) < 0);
    if (becomesCurrent && cur && cur.id !== v.id) {
      await query("UPDATE document_versions SET is_current = false, status = 'superseded' WHERE id = $1", [cur.id], client);
      await query("UPDATE document_chunks SET is_current = false WHERE version_id = $1", [cur.id], client);
    }
    await query(
      `UPDATE document_versions SET status = $2, is_current = $3, chunk_count = $4, page_count = $5, chunking_strategy = $6, chunker_version = $7,
              warnings = $8, version_label = $9, release = $10, published_at = COALESCE($11::date, published_at), language = COALESCE($12, language)
       WHERE id = $1`,
      [v.id, becomesCurrent ? "indexed" : "superseded", becomesCurrent, result.chunks.length, out.pageCount, result.strategy, CHUNKER_VERSION,
       JSON.stringify(metaWarnings.slice(0, 50)), versionLabel, release, publishedAt, out.language],
      client,
    );
    await query("UPDATE document_chunks SET searchable = $2, is_current = $3, release = $4 WHERE version_id = $1", [v.id, searchable, becomesCurrent, release], client);
    if (becomesCurrent) {
      await query(
        "UPDATE documents SET current_version_id = $2, title = $3, spec_type = COALESCE($4, spec_type), tags = $5, updated_at = now() WHERE id = $1",
        [v.document_id, v.id, title.slice(0, 500), specType, tags],
        client,
      );
    }
  });
  logger.info("ingest.indexed", { jobId: job.id, versionId: v.id, chunks: result.chunks.length });
  // A re-index leaves the previous chunks, sections and vectors as dead rows; make that space reusable now.
  if (replacing) await vacuum(["document_chunks", "document_sections", "embeddings"]);
  return { chunks: result.chunks.length, sections: result.sections.length, embedded: toEmbed.length, cacheHits: hashes.length - toEmbed.length, pages: out.pageCount, title, version: versionLabel, warnings: metaWarnings.length };
}

export async function markVersionFailed(versionId: string | null, error: string) {
  if (!versionId) return;
  await query("UPDATE document_versions SET status = 'failed', warnings = warnings || $2::jsonb WHERE id = $1 AND status <> 'indexed'", [versionId, JSON.stringify([`Indexing failed: ${error.slice(0, 500)}`])]);
}
