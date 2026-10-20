import { z } from "zod";
import { route, json, requireUser, requireAdmin, parseBody } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { listSources, ensureCommonsWorkspace } from "@/lib/sources/registry";
import { queryOne } from "@/lib/db";
import { validateUrlShape } from "@/lib/security/ssrf";
import { SOURCE_TYPES, isSourceType } from "@/lib/ingest/source-types";

export const GET = route(async () => {
  const user = await requireUser();
  return json({ sources: await listSources(await readableWorkspaceIds(user)) });
});

const Body = z.object({
  kind: z.enum(["url", "git_repo", "3gpp_archive"]),
  name: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000),
  sourceType: z.string(),
  trustLevel: z.enum(["official", "trusted", "community", "unverified"]).default("unverified"),
  license: z.string().max(300).optional(),
  syncIntervalHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
});

/** Admins register new sources; they start paused until explicitly activated (approval step). */
export const POST = route(async (req) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, Body);
  validateUrlShape(b.url);
  const st = isSourceType(b.sourceType) ? b.sourceType : "unverified";
  const ws = await ensureCommonsWorkspace();
  const row = await queryOne(
    `INSERT INTO document_sources(workspace_id, kind, name, url, authority_tier, source_type, trust_level, access_method, license, status, config, sync_interval_hours, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'paused',$10,$11,$12) RETURNING *`,
    [ws, b.kind, b.name, b.url, SOURCE_TYPES[st].tier, st, b.trustLevel, b.kind === "git_repo" ? "git clone (shallow)" : "https fetch", b.license ?? null, b.config, b.syncIntervalHours ?? null, admin.id],
  );
  return json({ source: row });
});
