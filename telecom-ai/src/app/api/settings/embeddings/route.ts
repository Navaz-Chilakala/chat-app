import { z } from "zod";
import { route, json, requireUser, requireAdmin, parseBody, HttpError } from "@/lib/http";
import { query, queryOne, tx } from "@/lib/db";
import { embeddingProvider } from "@/lib/embeddings";
import { enqueueJob } from "@/lib/ingest/queue";
import { ensureCommonsWorkspace } from "@/lib/sources/registry";
import { ocrConfig } from "@/lib/ingest/ocr-config";

export const GET = route(async () => {
  await requireUser();
  const models = await query(
    `SELECT m.*, (SELECT count(*)::int FROM embeddings e WHERE e.model_id = m.id) AS vectors, (SELECT count(*)::int FROM document_chunks) AS chunks FROM embedding_models m ORDER BY id`,
  );
  const p = embeddingProvider();
  return json({ models, configured: { provider: p.provider, model: p.model, dimensions: p.dimensions, version: p.version }, ocr: ocrConfig(), llm: "none (pure retrieval; answers are extractive quotes)" });
});

const Body = z.discriminatedUnion("action", [z.object({ action: z.literal("reembed") }), z.object({ action: z.literal("activate"), modelId: z.number().int() })]);

export const POST = route(async (req) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, Body);
  if (b.action === "reembed") {
    const job = await enqueueJob({ workspaceId: await ensureCommonsWorkspace(), kind: "reembed", priority: 8, createdBy: admin.id, maxAttempts: 5 });
    return json({ jobId: job.id });
  }
  const cov = await queryOne<{ missing: number }>("SELECT count(*)::int AS missing FROM document_chunks c WHERE NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id AND e.model_id = $1)", [b.modelId]);
  if (!cov) throw new HttpError(404, "Model not found");
  if (cov.missing > 0) throw new HttpError(409, `${cov.missing} chunk(s) are not yet embedded with this model; run re-embedding first`);
  await tx(async (c) => {
    await query("UPDATE embedding_models SET is_active = false WHERE is_active", [], c);
    await query("UPDATE embedding_models SET is_active = true WHERE id = $1", [b.modelId], c);
    await query("INSERT INTO audit_events(user_id, action, target_type, target_id) VALUES ($1,'embedding.activate','embedding_model',$2)", [admin.id, String(b.modelId)], c);
  });
  return json({ ok: true });
});
