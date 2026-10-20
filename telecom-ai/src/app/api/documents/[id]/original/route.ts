import { route, requireUser, HttpError } from "@/lib/http";
import { documentAccess } from "@/lib/auth/access";
import { queryOne } from "@/lib/db";
import { storage } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

/** Authorised download of a stored original (private storage; no public URLs). */
export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  if (!(await documentAccess(user, id))) throw new HttpError(404, "Document not found");
  const versionId = req.nextUrl.searchParams.get("version");
  const v = await queryOne<{ storage_key: string | null; original_filename: string | null; mime_type: string; source_url: string | null }>(
    `SELECT storage_key, original_filename, mime_type, source_url FROM document_versions WHERE document_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY is_current DESC, created_at DESC LIMIT 1`,
    [id, versionId],
  );
  if (!v) throw new HttpError(404, "Version not found");
  if (!v.storage_key) {
    if (v.source_url) return Response.redirect(v.source_url, 302); // reference-only source (e.g. official 3GPP archive)
    throw new HttpError(404, "No stored original for this version");
  }
  const data = await storage().get(v.storage_key);
  const filename = (v.original_filename ?? "document").replace(/[^\w.\-]+/g, "_");
  return new Response(new Uint8Array(data), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});
