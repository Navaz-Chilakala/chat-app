import { z } from "zod";
import { route, json, requireAdmin, parseBody, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({
  status: z.enum(["active", "paused", "disabled", "rejected"]).optional(),
  syncIntervalHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const admin = await requireAdmin();
  const { id } = await params;
  const b = await parseBody(req, Body);
  const row = await queryOne(
    `UPDATE document_sources SET status = COALESCE($2, status), sync_interval_hours = CASE WHEN $3::boolean THEN $4 ELSE sync_interval_hours END,
       config = COALESCE($5, config) WHERE id = $1 RETURNING *`,
    [id, b.status ?? null, b.syncIntervalHours !== undefined, b.syncIntervalHours ?? null, b.config ?? null],
  );
  if (!row) throw new HttpError(404, "Source not found");
  if (b.status === "disabled" || b.status === "rejected") {
    // Disabling a source removes its documents from search (history retained).
    await query("UPDATE document_chunks c SET searchable = false FROM documents d WHERE d.id = c.document_id AND d.source_id = $1", [id]);
  }
  await query("INSERT INTO audit_events(user_id, action, target_type, target_id, data) VALUES ($1,'source.updated','source',$2,$3)", [admin.id, id, b]);
  return json({ source: row });
});
