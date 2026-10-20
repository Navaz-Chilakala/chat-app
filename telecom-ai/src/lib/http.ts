import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { currentUser, type SessionUser } from "./auth/session";
import { logger, errorMessage } from "./logger";
import { rateLimit } from "./security/rate-limit";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, headers: { "cache-control": "no-store", ...(init?.headers ?? {}) } });
}

/** CSRF defence for cookie-authenticated mutations: the Origin (or Referer) must match the request host. */
export function assertSameOrigin(req: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new HttpError(403, "Missing origin");
  try {
    if (new URL(origin).host !== host) throw new HttpError(403, "Cross-origin request rejected");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(403, "Invalid origin");
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Authentication required");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new HttpError(403, "Administrator permission required");
  return user;
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return schema.parse(body);
}

export function clientKey(req: NextRequest, user?: SessionUser | null): string {
  if (user) return `u:${user.id}`;
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "unknown";
  return `ip:${ip}`;
}

export async function limit(req: NextRequest, user: SessionUser | null, bucket: string, max: number, windowSec: number) {
  const ok = await rateLimit(`${bucket}:${clientKey(req, user)}`, max, windowSec);
  if (!ok) throw new HttpError(429, "Too many requests — please slow down");
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Response>;

/** Wrap a route handler: request id, CSRF check, uniform error responses (no internals leaked). */
export function route<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    try {
      assertSameOrigin(req);
      const res = await handler(req, ctx);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code, requestId }, { status: err.status });
      if (err instanceof ZodError) return json({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })), requestId }, { status: 400 });
      logger.error("api.error", { requestId, path: req.nextUrl.pathname, error: errorMessage(err), stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5).join(" | ") : undefined });
      return json({ error: "Internal error", requestId }, { status: 500 });
    }
  };
}
