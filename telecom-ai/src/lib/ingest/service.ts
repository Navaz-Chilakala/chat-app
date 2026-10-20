import { query, queryOne, tx } from "../db";
import { storage } from "../storage";
import { sha256 } from "./hash";
import { enqueueJob } from "./queue";
import { parseSpecFilename, inferSpecType, tagsForSpec } from "../telecom/spec";
import { SOURCE_TYPES, type SourceType } from "./source-types";

export interface NewVersionInput {
  workspaceId: string;
  userId: string | null;
  filename: string;
  data: Buffer | null; // null when only a source reference is stored (e.g. 3GPP archive)
  checksum?: string;
  byteSize?: number;
  mimeType: string;
  sourceType: SourceType;
  sourceId?: string | null;
  sourceUrl?: string | null;
  docKey?: string;
  title?: string;
  reviewStatus?: "approved" | "pending";
  versionLabel?: string | null;
  release?: number | null;
  publishedAt?: string | null;
  license?: string | null;
  commitSha?: string | null;
  repoPath?: string | null;
  language?: string | null;
  metadata?: Record<string, unknown>;
  priority?: number;
  enqueue?: boolean;
}

export interface NewVersionResult {
  documentId: string;
  versionId: string;
  jobId: string | null;
  duplicate: boolean;
  duplicateOf?: { documentId: string; versionId: string; title: string };
}

function storageKey(workspaceId: string, checksum: string, filename: string) {
  const ext = (filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
  return `ws/${workspaceId}/${checksum.slice(0, 2)}/${checksum}.${ext}`;
}

/**
 * Create (or reuse) a document and add a new immutable version. Identical bytes already present in the
 * workspace are reported as a duplicate and never re-embedded. A changed file under the same doc_key
 * becomes a new version; the previous version stays in history until the new one finishes indexing.
 */
export async function createDocumentVersion(input: NewVersionInput): Promise<NewVersionResult> {
  const checksum = input.checksum ?? sha256(input.data!);
  const byteSize = input.byteSize ?? input.data?.length ?? 0;
  const spec = parseSpecFilename(input.filename);
  const docKey = input.docKey ?? (spec ? `3gpp:${spec.specNumber}` : `upload:${input.filename.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`);

  const dup = await queryOne<{ document_id: string; version_id: string; title: string }>(
    `SELECT d.id AS document_id, v.id AS version_id, d.title FROM document_versions v
     JOIN documents d ON d.id = v.document_id WHERE d.workspace_id = $1 AND v.checksum = $2 LIMIT 1`,
    [input.workspaceId, checksum],
  );
  if (dup) {
    return { documentId: dup.document_id, versionId: dup.version_id, jobId: null, duplicate: true, duplicateOf: { documentId: dup.document_id, versionId: dup.version_id, title: dup.title } };
  }

  const key = input.data ? storageKey(input.workspaceId, checksum, input.filename) : null;
  if (input.data && key) await storage().put(key, input.data, input.mimeType);

  const tier = SOURCE_TYPES[input.sourceType].tier;
  const specNumber = spec?.specNumber ?? null;
  const title = input.title ?? (spec ? `3GPP ${inferSpecType(spec.specNumber)} ${spec.specNumber}` : input.filename);
  return tx(async (client) => {
    const doc = await queryOne<{ id: string }>(
      `INSERT INTO documents(workspace_id, source_id, doc_key, title, source_type, authority_tier, spec_number, spec_type, series, tags, review_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_id, doc_key) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [
        input.workspaceId,
        input.sourceId ?? null,
        docKey,
        title,
        input.sourceType,
        tier,
        specNumber,
        specNumber ? inferSpecType(specNumber) : null,
        spec?.series ?? null,
        tagsForSpec(specNumber, title),
        input.reviewStatus ?? "approved",
        input.userId,
      ],
      client,
    );
    const version = await queryOne<{ id: string }>(
      `INSERT INTO document_versions(document_id, version_label, release, checksum, mime_type, byte_size, original_filename, source_url, storage_key,
                                     published_at, license, commit_sha, repo_path, language, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        doc!.id,
        input.versionLabel ?? spec?.version ?? null,
        input.release ?? spec?.release ?? null,
        checksum,
        input.mimeType,
        byteSize,
        input.filename,
        input.sourceUrl ?? null,
        key,
        input.publishedAt ?? null,
        input.license ?? null,
        input.commitSha ?? null,
        input.repoPath ?? null,
        input.language ?? null,
        input.metadata ?? {},
      ],
      client,
    );
    let jobId: string | null = null;
    if (input.enqueue !== false) {
      const job = await enqueueJob(
        { workspaceId: input.workspaceId, kind: "index_version", documentVersionId: version!.id, byteSize, priority: input.priority ?? 5, createdBy: input.userId },
        client,
      );
      jobId = job.id;
    }
    await query(
      "INSERT INTO audit_events(user_id, workspace_id, action, target_type, target_id, data) VALUES ($1,$2,'document.version_created','document_version',$3,$4)",
      [input.userId, input.workspaceId, version!.id, { filename: input.filename, checksum, docKey }],
      client,
    );
    return { documentId: doc!.id, versionId: version!.id, jobId, duplicate: false };
  });
}

/** Delete a document: cascades to versions, sections, chunks, embeddings, API entities; removes stored originals. */
export async function deleteDocument(documentId: string, userId: string | null): Promise<void> {
  const keys = await query<{ storage_key: string }>("SELECT storage_key FROM document_versions WHERE document_id = $1 AND storage_key IS NOT NULL", [documentId]);
  const doc = await queryOne<{ workspace_id: string; title: string }>("SELECT workspace_id, title FROM documents WHERE id = $1", [documentId]);
  if (!doc) return;
  await tx(async (client) => {
    await query("DELETE FROM documents WHERE id = $1", [documentId], client);
    await query(
      "INSERT INTO audit_events(user_id, workspace_id, action, target_type, target_id, data) VALUES ($1,$2,'document.deleted','document',$3,$4)",
      [userId, doc.workspace_id, documentId, { title: doc.title }],
      client,
    );
  });
  for (const k of keys) {
    // Blobs are content-addressed per workspace; only delete if no other version references them.
    const still = await queryOne("SELECT 1 FROM document_versions WHERE storage_key = $1 LIMIT 1", [k.storage_key]);
    if (!still) await storage().delete(k.storage_key).catch(() => undefined);
  }
}

/** Approve/reject a document awaiting review; approval makes its indexed chunks searchable. */
export async function setReviewStatus(documentId: string, status: "approved" | "rejected", userId: string) {
  await tx(async (client) => {
    await query("UPDATE documents SET review_status = $2, updated_at = now() WHERE id = $1", [documentId, status], client);
    await query(
      `UPDATE document_chunks c SET searchable = ($2 = 'approved') AND v.status IN ('indexed','superseded')
       FROM document_versions v WHERE v.id = c.version_id AND c.document_id = $1`,
      [documentId, status],
      client,
    );
    await query("INSERT INTO audit_events(user_id, action, target_type, target_id, data) VALUES ($1,'document.review','document',$2,$3)", [userId, documentId, { status }], client);
  });
}
