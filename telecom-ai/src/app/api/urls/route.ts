import { z } from "zod";
import { route, json, requireUser, parseBody, limit, HttpError } from "@/lib/http";
import { hasRole, userWorkspaces } from "@/lib/auth/access";
import { enqueueJob } from "@/lib/ingest/queue";
import { validateUrlShape, UnsafeUrlError } from "@/lib/security/ssrf";
import { env } from "@/lib/env";
import { isSourceType, SOURCE_TYPES } from "@/lib/ingest/source-types";

const Body = z.object({ urls: z.array(z.string().url().max(2000)).min(1).max(20), workspaceId: z.string().uuid(), sourceType: z.string().default("unverified") });

export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "url-ingest", 30, 3600);
  const b = await parseBody(req, Body);
  const ws = (await userWorkspaces(user.id)).find((w) => w.id === b.workspaceId);
  if (!ws) throw new HttpError(403, "No access to workspace");
  let sourceType = isSourceType(b.sourceType) ? b.sourceType : "unverified";
  if (SOURCE_TYPES[sourceType].tier <= 2 && !user.isAdmin) sourceType = "unverified";
  const reviewStatus = ws.kind === "shared" && !hasRole(ws.role, "editor") && !user.isAdmin ? "pending" : "approved";
  const allowedHosts = env().URL_INGEST_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean);
  const results = [];
  for (const url of b.urls) {
    try {
      validateUrlShape(url, { allowedHosts }); // fast rejection; DNS and redirects are re-validated in the worker
      const job = await enqueueJob({ workspaceId: b.workspaceId, kind: "fetch_url", payload: { url, sourceType, reviewStatus }, createdBy: user.id, priority: 3 });
      results.push({ url, ok: true, jobId: job.id });
    } catch (err) {
      results.push({ url, ok: false, error: err instanceof UnsafeUrlError ? err.message : "Invalid URL" });
    }
  }
  return json({ results });
});
