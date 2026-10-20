import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query } from "@/lib/db";

export const GET = route(async (req) => {
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const ws = await readableWorkspaceIds(user, sp.getAll("workspace").filter(Boolean));
  const args: unknown[] = [ws];
  const where = ["d.workspace_id = ANY($1)"];
  const add = (v: unknown) => (args.push(v), `$${args.length}`);
  if (sp.get("q")) where.push(`(d.title ILIKE ${add(`%${sp.get("q")}%`)} OR d.spec_number = ${add(sp.get("q"))})`);
  if (sp.get("sourceType")) where.push(`d.source_type = ${add(sp.get("sourceType"))}`);
  if (sp.get("review")) where.push(`d.review_status = ${add(sp.get("review"))}`);
  if (sp.get("tag")) where.push(`${add(sp.get("tag"))} = ANY(d.tags)`);
  if (sp.get("sourceId")) where.push(`d.source_id = ${add(sp.get("sourceId"))}`);
  const lim = Math.min(200, Number(sp.get("limit") ?? 50));
  const offset = Math.max(0, Number(sp.get("offset") ?? 0));
  const rows = await query(
    `SELECT d.id, d.title, d.spec_number, d.spec_type, d.source_type, d.authority_tier, d.review_status, d.tags, d.updated_at, d.workspace_id,
            v.version_label, v.release, v.status, v.chunk_count, v.page_count, v.byte_size, v.original_filename, v.commit_sha, v.repo_path,
            (SELECT count(*)::int FROM document_versions vv WHERE vv.document_id = d.id) AS version_count,
            (SELECT status FROM document_versions vv WHERE vv.document_id = d.id ORDER BY created_at DESC LIMIT 1) AS latest_status
     FROM documents d LEFT JOIN document_versions v ON v.id = d.current_version_id
     WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC LIMIT ${lim} OFFSET ${offset}`,
    args,
  );
  const total = await query<{ n: number }>(`SELECT count(*)::int AS n FROM documents d WHERE ${where.join(" AND ")}`, args);
  return json({ documents: rows, total: total[0]?.n ?? 0 });
});
