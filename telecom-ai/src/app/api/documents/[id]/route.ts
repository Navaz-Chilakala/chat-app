import { route, json, requireUser, HttpError } from "@/lib/http";
import { documentAccess, hasRole } from "@/lib/auth/access";
import { query, queryOne } from "@/lib/db";
import { enqueueJob } from "@/lib/ingest/queue";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  if (!(await documentAccess(user, id))) throw new HttpError(404, "Document not found");
  const doc = await queryOne(
    `SELECT d.*, s.name AS source_name, s.url AS source_url, s.license AS source_license FROM documents d LEFT JOIN document_sources s ON s.id = d.source_id WHERE d.id = $1`,
    [id],
  );
  const versions = await query(
    `SELECT id, version_label, release, checksum, mime_type, byte_size, original_filename, source_url, published_at, retrieved_at, status, is_current,
            page_count, chunk_count, chunking_strategy, chunker_version, license, commit_sha, repo_path, language, warnings, created_at,
            (storage_key IS NOT NULL) AS has_original
     FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC`,
    [id],
  );
  const versionId = req.nextUrl.searchParams.get("version") ?? (doc as { current_version_id: string | null })?.current_version_id ?? (versions[0] as { id: string } | undefined)?.id;
  const sections = versionId
    ? await query("SELECT id, parent_id, clause, heading, level, ord, page_start, page_end FROM document_sections WHERE version_id = $1 ORDER BY ord LIMIT 5000", [versionId])
    : [];
  const jobs = await query("SELECT id, kind, status, stage, progress, attempts, error, created_at, finished_at FROM ingestion_jobs WHERE document_version_id = ANY($1) ORDER BY created_at DESC LIMIT 20", [versions.map((v) => (v as { id: string }).id)]);
  return json({ document: doc, versions, sections, jobs, versionId });
});

export const DELETE = route<Ctx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id } = await params;
  const access = await documentAccess(user, id);
  if (!access) throw new HttpError(404, "Document not found");
  if (!hasRole(access.role, "editor") && !user.isAdmin) throw new HttpError(403, "Editor permission required to delete");
  // Hide immediately, then delete (with chunks, embeddings and originals) in the background.
  await query("UPDATE document_chunks SET searchable = false WHERE document_id = $1", [id]);
  const job = await enqueueJob({ workspaceId: access.workspaceId, kind: "delete_document", payload: { documentId: id }, priority: 1, createdBy: user.id });
  return json({ ok: true, jobId: job.id });
});
