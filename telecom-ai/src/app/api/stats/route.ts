import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query, queryOne } from "@/lib/db";

/** Knowledge-base dashboard. Every number is a live database query. */
export const GET = route(async () => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const [totals, byAuthority, byType, queue, failed, sync, storage, cost, review, models, tags, ocr] = await Promise.all([
    queryOne(
      `SELECT (SELECT count(*)::int FROM documents WHERE workspace_id = ANY($1)) AS documents,
              (SELECT count(*)::int FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.workspace_id = ANY($1) AND v.status IN ('indexed','superseded')) AS indexed_versions,
              (SELECT count(*)::int FROM document_chunks WHERE workspace_id = ANY($1)) AS chunks,
              (SELECT count(*)::int FROM document_chunks WHERE workspace_id = ANY($1) AND searchable) AS searchable_chunks,
              (SELECT count(*)::int FROM embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.workspace_id = ANY($1)) AS embeddings,
              (SELECT count(DISTINCT spec_number)::int FROM documents WHERE workspace_id = ANY($1) AND spec_number IS NOT NULL) AS specs`,
      [ws],
    ),
    query("SELECT authority_tier, source_type, count(*)::int AS n FROM documents WHERE workspace_id = ANY($1) GROUP BY 1, 2 ORDER BY 1, 3 DESC", [ws]),
    query("SELECT chunk_type, count(*)::int AS n FROM document_chunks WHERE workspace_id = ANY($1) GROUP BY 1 ORDER BY 2 DESC", [ws]),
    query("SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE workspace_id = ANY($1) GROUP BY 1", [ws]),
    query("SELECT j.id, j.kind, j.error, j.finished_at, d.title FROM ingestion_jobs j LEFT JOIN document_versions v ON v.id = j.document_version_id LEFT JOIN documents d ON d.id = v.document_id WHERE j.workspace_id = ANY($1) AND j.status = 'failed' ORDER BY j.finished_at DESC NULLS LAST LIMIT 10", [ws]),
    query("SELECT s.name, s.last_synced_at, s.status FROM document_sources s WHERE s.workspace_id = ANY($1) ORDER BY s.last_synced_at DESC NULLS LAST LIMIT 10", [ws]),
    queryOne(
      `SELECT COALESCE(sum(v.byte_size),0)::bigint AS original_bytes, COALESCE(sum(v.byte_size) FILTER (WHERE v.storage_key IS NOT NULL),0)::bigint AS stored_bytes,
              pg_database_size(current_database())::bigint AS database_bytes
       FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.workspace_id = ANY($1)`,
      [ws],
    ),
    queryOne("SELECT COALESCE(sum(tokens),0)::bigint AS tokens, COALESCE(sum(texts),0)::bigint AS texts, COALESCE(sum(cache_hits),0)::bigint AS cache_hits, COALESCE(sum(est_cost_usd),0)::float AS cost_usd FROM embedding_usage"),
    query("SELECT id, title, created_at FROM documents WHERE workspace_id = ANY($1) AND review_status = 'pending' ORDER BY created_at LIMIT 20", [ws]),
    query("SELECT m.id, m.provider, m.model, m.dimensions, m.version, m.is_active, (SELECT count(*)::int FROM embeddings e WHERE e.model_id = m.id) AS vectors FROM embedding_models m ORDER BY m.id"),
    query("SELECT t AS tag, count(*)::int AS n FROM documents, unnest(tags) t WHERE workspace_id = ANY($1) GROUP BY t ORDER BY 2 DESC LIMIT 20", [ws]),
    queryOne("SELECT count(*) FILTER (WHERE 'ocr' = ANY(flags))::int AS ocr_chunks, count(*) FILTER (WHERE 'ocr_low_confidence' = ANY(flags))::int AS low_confidence FROM document_chunks WHERE workspace_id = ANY($1)", [ws]),
  ]);
  const indexHealth = await queryOne(
    `SELECT (SELECT count(*)::int FROM document_chunks c WHERE c.workspace_id = ANY($1) AND c.searchable AND NOT EXISTS (SELECT 1 FROM embeddings e JOIN embedding_models m ON m.id = e.model_id AND m.is_active WHERE e.chunk_id = c.id)) AS searchable_without_vector,
            (SELECT count(*)::int FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.workspace_id = ANY($1) AND v.status = 'failed') AS failed_versions,
            (SELECT count(*)::int FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.workspace_id = ANY($1) AND v.status IN ('pending','processing')) AS pending_versions`,
    [ws],
  );
  return json({ totals, byAuthority, byType, queue, failed, sync, storage, cost, review, models, tags, ocr, indexHealth });
});
