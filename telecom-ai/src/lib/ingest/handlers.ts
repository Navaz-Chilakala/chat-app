import { query, queryOne } from "../db";
import { registerJobHandler } from "./runner";
import { safeFetch } from "../security/ssrf";
import { createDocumentVersion, deleteDocument } from "./service";
import { PermanentError } from "./pipeline";
import { robotsAllows, USER_AGENT } from "../sources/robots";
import { syncThreeGpp, type ThreeGppConfig } from "../sources/threegpp";
import { syncGitRepo, type GitConfig } from "../sources/git";
import { htmlTitle } from "./extract/html";
import { env } from "../env";
import { isSourceType } from "./source-types";
import { embeddingProvider, ensureEmbeddingModel, toVectorLiteral } from "../embeddings";
import { heartbeat, jobEvent } from "./queue";

registerJobHandler("fetch_url", async (job) => {
  const p = job.payload as { url: string; sourceType?: string; title?: string; reviewStatus?: "approved" | "pending" };
  const allowedHosts = env().URL_INGEST_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
  if (!(await robotsAllows(p.url))) throw new PermanentError(`robots.txt disallows fetching ${p.url}`);
  const res = await safeFetch(p.url, { maxBytes: env().MAX_UPLOAD_MB * 1024 * 1024, allowedHosts, userAgent: USER_AGENT });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} fetching ${p.url}`);
  const ct = res.contentType.toLowerCase();
  const urlPath = new URL(res.url).pathname;
  let filename = decodeURIComponent(urlPath.split("/").pop() || "index");
  if (ct.includes("html") && !/\.html?$/i.test(filename)) filename += ".html";
  else if (ct.includes("pdf") && !/\.pdf$/i.test(filename)) filename += ".pdf";
  else if (!filename.includes(".")) filename += ct.includes("json") ? ".json" : ct.includes("yaml") ? ".yaml" : ".txt";
  const title = p.title ?? (ct.includes("html") ? htmlTitle(res.body.toString("utf8")) : null) ?? filename;
  const r = await createDocumentVersion({
    workspaceId: job.workspace_id,
    userId: job.created_by,
    filename,
    data: res.body,
    mimeType: ct || "application/octet-stream",
    sourceType: p.sourceType && isSourceType(p.sourceType) ? p.sourceType : "unverified",
    sourceUrl: res.url,
    docKey: `url:${res.url}`,
    title,
    reviewStatus: p.reviewStatus ?? "approved",
    metadata: { fetchedUrl: res.url, requestedUrl: p.url, contentType: ct, retrievedAt: new Date().toISOString() },
  });
  return { url: res.url, bytes: res.body.length, duplicate: r.duplicate, documentId: r.documentId, indexJobId: r.jobId };
});

registerJobHandler("sync_source", async (job) => {
  const s = await queryOne<{ id: string; workspace_id: string; kind: string; url: string; config: Record<string, unknown>; status: string; license: string | null; source_type: string }>(
    "SELECT id, workspace_id, kind, url, config, status, license, source_type FROM document_sources WHERE id = $1",
    [job.source_id],
  );
  if (!s) throw new PermanentError("Source no longer exists");
  if (s.status !== "active") throw new PermanentError(`Source is ${s.status}; activate it before syncing`);
  if (s.kind === "3gpp_archive") return syncThreeGpp(job, { ...s, config: s.config as ThreeGppConfig });
  if (s.kind === "git_repo") return syncGitRepo(job, { ...s, config: s.config as GitConfig });
  if (s.kind === "url") {
    await query("INSERT INTO ingestion_jobs(workspace_id, kind, payload, created_by) VALUES ($1,'fetch_url',$2,$3)", [s.workspace_id, { url: s.url, sourceType: s.source_type }, job.created_by]);
    return { queued: "fetch_url" };
  }
  throw new PermanentError(`Unsupported source kind ${s.kind}`);
});

/** Controlled re-embedding: fill embeddings for the configured model without touching the active index. */
registerJobHandler("reembed", async (job) => {
  const provider = embeddingProvider();
  const modelId = await ensureEmbeddingModel(provider);
  let done = 0;
  const total = (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM document_chunks c WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model_id = $1)", [modelId]))!.n;
  for (;;) {
    const rows = await query<{ id: string; heading_path: string | null; content: string; content_hash: string }>(
      `SELECT c.id, c.heading_path, c.content, c.content_hash FROM document_chunks c
       WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model_id = $1) LIMIT 256`,
      [modelId],
    );
    if (!rows.length) break;
    const cached = new Map((await query<{ content_hash: string; embedding: string }>("SELECT content_hash, embedding::text AS embedding FROM embedding_cache WHERE model_id = $1 AND content_hash = ANY($2)", [modelId, rows.map((r) => r.content_hash)])).map((r) => [r.content_hash, r.embedding]));
    const missing = rows.filter((r) => !cached.has(r.content_hash));
    for (let i = 0; i < missing.length; i += 64) {
      const batch = missing.slice(i, i + 64);
      const { vectors } = await provider.embed(batch.map((r) => `${r.heading_path ?? ""}\n${r.content}`.slice(0, 8000)));
      batch.forEach((r, k) => cached.set(r.content_hash, toVectorLiteral(vectors[k]!)));
      await query(
        "INSERT INTO embedding_cache(content_hash, model_id, embedding) SELECT x.h, $1, x.v::vector FROM jsonb_to_recordset($2::jsonb) AS x(h text, v text) ON CONFLICT DO NOTHING",
        [modelId, JSON.stringify(batch.map((r) => ({ h: r.content_hash, v: cached.get(r.content_hash) })))],
      );
    }
    await query(
      "INSERT INTO embeddings(chunk_id, model_id, embedding) SELECT x.id, $1, x.v::vector FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, v text) ON CONFLICT DO NOTHING",
      [modelId, JSON.stringify(rows.map((r) => ({ id: r.id, v: cached.get(r.content_hash) })))],
    );
    done += rows.length;
    if ((await heartbeat(job.id, "reembed", Math.min(0.99, done / Math.max(1, total)))).cancel) break;
  }
  await jobEvent(job.id, "info", "reembed", `Embedded ${done} chunk(s) for model #${modelId}. Activate it from Settings once complete.`);
  return { modelId, embedded: done };
});

registerJobHandler("delete_document", async (job) => {
  const documentId = String((job.payload as { documentId: string }).documentId);
  await deleteDocument(documentId, job.created_by);
  return { deleted: documentId };
});
