import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";
import { query, queryOne, tx } from "../db";
import { env } from "../env";
import { ensureCommonsWorkspace } from "../sources/registry";

export const SESSION_COOKIE = "tk_session";
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(`${token}:${env().SESSION_SECRET}`).digest("hex");
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}

export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await query("INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,$2,$3)", [userId, hashToken(token), expires]);
  await query("DELETE FROM sessions WHERE expires_at < now()");
  return { token, expires };
}

export async function setSessionCookie(token: string, expires: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 200) return null;
  const row = await queryOne<{ id: string; email: string; display_name: string; is_admin: boolean }>(
    `SELECT u.id, u.email, u.display_name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)],
  );
  return row ? { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin } : null;
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  jar.delete(SESSION_COOKIE);
}

/** Register a user. The first user becomes admin. Every user joins the shared Commons and gets a personal workspace. */
export async function registerUser(email: string, password: string, displayName: string): Promise<SessionUser> {
  const commons = await ensureCommonsWorkspace();
  return tx(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(727002)"); // serialise "first user is admin"
    const count = (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM users", [], client))!.n;
    const e = env();
    if (e.SIGNUP_MODE === "invite") {
      // The allowlist also applies to the first account, so nobody else can claim admin on a public URL.
      const allowed = e.ALLOWED_SIGNUP_EMAILS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      if ((count > 0 || allowed.length) && !allowed.includes(email.toLowerCase())) throw new Error("SIGNUP_NOT_ALLOWED");
    }
    const exists = await queryOne("SELECT 1 FROM users WHERE email = $1", [email], client);
    if (exists) throw new Error("EMAIL_TAKEN");
    const isAdmin = count === 0;
    const user = (await queryOne<{ id: string }>(
      "INSERT INTO users(email, password_hash, display_name, is_admin) VALUES ($1,$2,$3,$4) RETURNING id",
      [email, await hashPassword(password), displayName, isAdmin],
      client,
    ))!;
    await query("INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1,$2,$3)", [commons, user.id, isAdmin ? "owner" : "viewer"], client);
    const personal = (await queryOne<{ id: string }>(
      "INSERT INTO workspaces(name, slug, kind) VALUES ($1,$2,'personal') RETURNING id",
      [`${displayName}'s workspace`, `u-${user.id.slice(0, 8)}-${randomBytes(3).toString("hex")}`],
      client,
    ))!;
    await query("INSERT INTO workspace_memberships(workspace_id, user_id, role) VALUES ($1,$2,'owner')", [personal.id, user.id], client);
    await query("INSERT INTO audit_events(user_id, action, data) VALUES ($1,'user.registered',$2)", [user.id, { isAdmin }], client);
    return { id: user.id, email, displayName, isAdmin };
  });
}
