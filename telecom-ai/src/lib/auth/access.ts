import { query, queryOne } from "../db";
import type { SessionUser } from "./session";

export type Role = "owner" | "editor" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface WorkspaceAccess {
  id: string;
  name: string;
  slug: string;
  kind: string;
  role: Role;
}

export async function userWorkspaces(userId: string): Promise<WorkspaceAccess[]> {
  return query<WorkspaceAccess>(
    `SELECT w.id, w.name, w.slug, w.kind, m.role FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY (w.kind = 'shared') DESC, w.created_at`,
    [userId],
  );
}

export async function workspaceRole(userId: string, workspaceId: string): Promise<Role | null> {
  const r = await queryOne<{ role: Role }>("SELECT role FROM workspace_memberships WHERE user_id = $1 AND workspace_id = $2", [userId, workspaceId]);
  return r?.role ?? null;
}

export function hasRole(role: Role | null, min: Role): boolean {
  return !!role && RANK[role] >= RANK[min];
}

/** Workspace ids a user may read. Explicit workspace filters are intersected with this set server-side. */
export async function readableWorkspaceIds(user: SessionUser, requested?: string[]): Promise<string[]> {
  const mine = (await userWorkspaces(user.id)).map((w) => w.id);
  return requested?.length ? requested.filter((id) => mine.includes(id)) : mine;
}

/** Document-level access check (for citation viewers, downloads, deletes). */
export async function documentAccess(user: SessionUser, documentId: string): Promise<{ workspaceId: string; role: Role } | null> {
  const r = await queryOne<{ workspace_id: string; role: Role }>(
    `SELECT d.workspace_id, m.role FROM documents d JOIN workspace_memberships m ON m.workspace_id = d.workspace_id AND m.user_id = $2 WHERE d.id = $1`,
    [documentId, user.id],
  );
  return r ? { workspaceId: r.workspace_id, role: r.role } : null;
}
