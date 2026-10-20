import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query } from "@/lib/db";

/** Structured API search: exact operationId, path, method, response code, or free text over titles/summaries. */
export const GET = route(async (req) => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim();
  const status = sp.get("status");
  const method = sp.get("method")?.toUpperCase();
  const rows = await query(
    `SELECT o.id, o.version_id, o.chunk_id, o.api_title, o.api_version, o.openapi_version, o.method, o.path, o.operation_id, o.summary, o.tags, o.deprecated,
            (SELECT array_agg(k) FROM jsonb_object_keys(o.responses) k) AS response_codes, d.title AS document_title, d.id AS document_id, v.version_label
     FROM api_operations o JOIN document_versions v ON v.id = o.version_id JOIN documents d ON d.id = v.document_id
     WHERE d.workspace_id = ANY($1) AND v.is_current AND d.review_status = 'approved'
       AND ($2 = '' OR lower(o.operation_id) = lower($2) OR o.path ILIKE '%' || $2 || '%' OR o.api_title ILIKE '%' || $2 || '%' OR o.summary ILIKE '%' || $2 || '%' OR lower($2) = ANY(SELECT lower(t) FROM unnest(o.tags) t))
       AND ($3::text IS NULL OR o.responses ? $3)
       AND ($4::text IS NULL OR o.method = $4)
     ORDER BY (lower(o.operation_id) = lower($2)) DESC, o.api_title, o.path LIMIT 200`,
    [ws, q, status, method ?? null],
  );
  const apis = await query(
    `SELECT v.id AS version_id, min(o.api_title) AS api_title, min(o.api_version) AS api_version, count(*)::int AS operations, d.title
     FROM api_operations o JOIN document_versions v ON v.id = o.version_id JOIN documents d ON d.id = v.document_id
     WHERE d.workspace_id = ANY($1) AND v.is_current GROUP BY v.id, d.title ORDER BY 2`,
    [ws],
  );
  return json({ operations: rows, apis });
});
