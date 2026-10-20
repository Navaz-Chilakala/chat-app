import { z } from "zod";
import { route, json, requireAdmin, parseBody, HttpError } from "@/lib/http";
import { query } from "@/lib/db";
import { ensureCommonsWorkspace } from "@/lib/sources/registry";

export const GET = route(async () => {
  await requireAdmin();
  const commons = await ensureCommonsWorkspace();
  const users = await query(
    `SELECT u.id, u.email, u.display_name, u.is_admin, u.disabled_at, u.created_at, m.role AS commons_role
     FROM users u LEFT JOIN workspace_memberships m ON m.user_id = u.id AND m.workspace_id = $1 ORDER BY u.created_at`,
    [commons],
  );
  return json({ users });
});

const Body = z.object({ userId: z.string().uuid(), isAdmin: z.boolean().optional(), disabled: z.boolean().optional(), commonsRole: z.enum(["viewer", "editor", "owner"]).optional() });

export const PATCH = route(async (req) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, Body);
  if (b.userId === admin.id && (b.isAdmin === false || b.disabled)) throw new HttpError(400, "You cannot remove your own admin access or disable yourself");
  if (b.isAdmin !== undefined) await query("UPDATE users SET is_admin = $2 WHERE id = $1", [b.userId, b.isAdmin]);
  if (b.disabled !== undefined) {
    await query("UPDATE users SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END WHERE id = $1", [b.userId, b.disabled]);
    if (b.disabled) await query("DELETE FROM sessions WHERE user_id = $1", [b.userId]);
  }
  if (b.commonsRole) {
    const commons = await ensureCommonsWorkspace();
    await query("INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role", [commons, b.userId, b.commonsRole]);
  }
  await query("INSERT INTO audit_events(user_id, action, target_type, target_id, data) VALUES ($1,'user.updated','user',$2,$3)", [admin.id, b.userId, b]);
  return json({ ok: true });
});
