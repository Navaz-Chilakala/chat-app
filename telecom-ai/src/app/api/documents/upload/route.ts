import { route, json, requireUser, limit, HttpError } from "@/lib/http";
import { hasRole, userWorkspaces } from "@/lib/auth/access";
import { createDocumentVersion } from "@/lib/ingest/service";
import { SUPPORTED_EXTENSIONS, extensionOf, sniffFormat, looksBinary } from "@/lib/ingest/process";
import { isSourceType, SOURCE_TYPES } from "@/lib/ingest/source-types";
import { env } from "@/lib/env";

export const maxDuration = 60;

/**
 * Multipart upload. Files are validated (extension, magic bytes, size), checksummed, stored durably,
 * and an index job is queued; heavy processing happens in the background worker, never in this request.
 */
export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "upload", 60, 3600);
  const form = await req.formData();
  const workspaceId = String(form.get("workspaceId") ?? "");
  const ws = (await userWorkspaces(user.id)).find((w) => w.id === workspaceId);
  if (!ws) throw new HttpError(403, "You do not have access to this workspace");
  if (!hasRole(ws.role, "viewer")) throw new HttpError(403, "Insufficient permission");
  let sourceType = String(form.get("sourceType") ?? "user_provided");
  if (!isSourceType(sourceType)) throw new HttpError(400, "Unknown source type");
  // Only admins may label uploads as Tier-1 official material; everyone else's uploads are user-provided.
  if (SOURCE_TYPES[sourceType].tier <= 2 && !user.isAdmin) sourceType = "user_provided";
  // Uploads to the shared Commons by non-editors go to the review queue and are not searchable until approved.
  const reviewStatus = ws.kind === "shared" && !hasRole(ws.role, "editor") && !user.isAdmin ? "pending" : "approved";
  const maxBytes = env().MAX_UPLOAD_MB * 1024 * 1024;
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f);
  if (!files.length) throw new HttpError(400, "No files provided");
  if (files.length > 50) throw new HttpError(400, "At most 50 files per upload");
  const results = [];
  for (const file of files) {
    const name = file.name.replace(/[\\/]/g, "_").slice(0, 200) || "upload";
    const ext = extensionOf(name);
    if (!SUPPORTED_EXTENSIONS.includes(ext)) {
      results.push({ filename: name, ok: false, error: `Unsupported file type .${ext}` });
      continue;
    }
    if (file.size > maxBytes) {
      results.push({ filename: name, ok: false, error: `File exceeds ${env().MAX_UPLOAD_MB} MB` });
      continue;
    }
    const data = Buffer.from(await file.arrayBuffer());
    const format = sniffFormat(data, name);
    if ((format === "text" || format === "code" || format === "markdown" || format === "csv") && looksBinary(data)) {
      results.push({ filename: name, ok: false, error: "File content does not match its extension (binary data)" });
      continue;
    }
    try {
      const r = await createDocumentVersion({ workspaceId, userId: user.id, filename: name, data, mimeType: file.type || "application/octet-stream", sourceType: sourceType as keyof typeof SOURCE_TYPES, reviewStatus, priority: 3 });
      results.push({ filename: name, ok: true, format, ...r, reviewStatus });
    } catch (err) {
      results.push({ filename: name, ok: false, error: (err as Error).message.slice(0, 300) });
    }
  }
  return json({ results });
});
