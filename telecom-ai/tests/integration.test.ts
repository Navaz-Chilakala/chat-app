import "./setup-db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { migrate } from "@/lib/migrate";
import { closePool, query, queryOne } from "@/lib/db";
import { createDocumentVersion, deleteDocument, setReviewStatus } from "@/lib/ingest/service";
import { drainQueue } from "@/lib/ingest/runner";
import "@/lib/ingest/handlers";
import { ensureCommonsWorkspace } from "@/lib/sources/registry";
import { registerUser } from "@/lib/auth/session";
import { readableWorkspaceIds, userWorkspaces } from "@/lib/auth/access";
import { ask } from "@/lib/answer/engine";
import { hybridSearch } from "@/lib/retrieval/search";
import { terminateOcr } from "@/lib/ingest/ocr";
import { storage } from "@/lib/storage";

const fx = (f: string) => fs.readFileSync(path.join(__dirname, "fixtures", f));
let commons: string;

async function reset() {
  await query(`TRUNCATE users, workspaces, document_sources, embedding_models, evaluation_cases, evaluation_runs, audit_events, rate_limits, document_blobs RESTART IDENTITY CASCADE`);
  commons = await ensureCommonsWorkspace();
}

beforeAll(async () => {
  await migrate();
});
beforeEach(reset);
afterAll(async () => {
  await terminateOcr();
  await closePool();
});

describe("ingestion pipeline (Postgres + pgvector)", () => {
  it("indexes a 3GPP-styled DOCX durably with sections, chunks, embeddings and cover metadata", async () => {
    const r = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "synthetic-spec.docx", data: fx("synthetic-spec.docx"), mimeType: "application/octet-stream", sourceType: "user_provided" });
    expect(r.duplicate).toBe(false);
    expect(await drainQueue()).toBe(1);
    const v = await queryOne<{ status: string; is_current: boolean; version_label: string; release: number; chunk_count: number }>("SELECT status, is_current, version_label, release, chunk_count FROM document_versions WHERE id = $1", [r.versionId]);
    expect(v).toMatchObject({ status: "indexed", is_current: true, version_label: "1.2.0", release: 19 });
    const d = await queryOne<{ title: string; spec_number: string }>("SELECT title, spec_number FROM documents WHERE id = $1", [r.documentId]);
    expect(d).toEqual({ title: "3GPP TS 99.999: Synthetic Procedures for Parser Testing", spec_number: "99.999" });
    const counts = await queryOne<{ chunks: number; searchable: number; embedded: number; sections: number; abbr: number }>(
      `SELECT (SELECT count(*)::int FROM document_chunks WHERE version_id = $1) AS chunks, (SELECT count(*)::int FROM document_chunks WHERE version_id = $1 AND searchable) AS searchable,
              (SELECT count(*)::int FROM embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE c.version_id = $1) AS embedded,
              (SELECT count(*)::int FROM document_sections WHERE version_id = $1) AS sections, (SELECT count(*)::int FROM abbreviations) AS abbr`,
      [r.versionId],
    );
    expect(counts!.chunks).toBe(v!.chunk_count);
    expect(counts!.searchable).toBe(counts!.chunks);
    expect(counts!.embedded).toBe(counts!.chunks);
    expect(counts!.sections).toBeGreaterThan(8);
    expect(counts!.abbr).toBe(2);
  }, 120_000);

  it("detects duplicates, keeps version history and reuses embeddings for unchanged text", async () => {
    const v1 = Buffer.from("# Notes\n\n## Alpha\n\nThe alpha paragraph is unchanged between versions.\n\n## Beta\n\nOriginal beta text.\n");
    const v2 = Buffer.from("# Notes\n\n## Alpha\n\nThe alpha paragraph is unchanged between versions.\n\n## Beta\n\nRevised beta text with a new sentence.\n");
    const a = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "notes.md", data: v1, mimeType: "text/markdown", sourceType: "user_provided" });
    await drainQueue();
    const dup = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "copy-of-notes.md", data: v1, mimeType: "text/markdown", sourceType: "user_provided" });
    expect(dup.duplicate).toBe(true);
    expect(dup.jobId).toBeNull();
    const b = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "notes.md", data: v2, mimeType: "text/markdown", sourceType: "user_provided" });
    expect(b.documentId).toBe(a.documentId);
    await drainQueue();
    const versions = await query<{ id: string; status: string; is_current: boolean }>("SELECT id, status, is_current FROM document_versions WHERE document_id = $1 ORDER BY created_at", [a.documentId]);
    expect(versions.map((x) => [x.status, x.is_current])).toEqual([["superseded", false], ["indexed", true]]);
    const oldCurrent = await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM document_chunks WHERE version_id = $1 AND is_current", [a.versionId]);
    expect(oldCurrent!.n).toBe(0);
    const usage = await query<{ texts: number; cache_hits: number }>("SELECT texts, cache_hits FROM embedding_usage ORDER BY id");
    expect(usage[1]!.cache_hits).toBeGreaterThan(0); // unchanged chunks reused
    expect(usage[1]!.texts).toBeLessThan(usage[0]!.texts + 1);
  });

  it("OCRs a scanned PDF page so its text becomes searchable", async () => {
    const r = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "synthetic-scan.pdf", data: fx("synthetic-scan.pdf"), mimeType: "application/pdf", sourceType: "user_provided" });
    await drainQueue();
    const v = await queryOne<{ status: string; warnings: string[] }>("SELECT status, warnings FROM document_versions WHERE id = $1", [r.versionId]);
    expect(v!.status).toBe("indexed");
    expect(v!.warnings.join(" ")).toMatch(/recovered by OCR/);
    const chunk = await queryOne<{ content: string; flags: string[]; clause: string | null }>("SELECT content, flags, clause FROM document_chunks WHERE version_id = $1 AND content ILIKE '%GADGET RELEASE COMMAND%'", [r.versionId]);
    expect(chunk).not.toBeNull();
    expect(chunk!.flags).toContain("ocr");
    expect(chunk!.content).toContain("T3540");
    expect(chunk!.clause).toBe("7.1");
  }, 180_000);

  it("retries failed jobs safely without duplicating chunks", async () => {
    const r = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "retry.md", data: Buffer.from("# Retry\n\nRetry test paragraph about the widget timer.\n"), mimeType: "text/markdown", sourceType: "user_provided" });
    const key = (await queryOne<{ storage_key: string }>("SELECT storage_key FROM document_versions WHERE id = $1", [r.versionId]))!.storage_key;
    const blob = await storage().get(key);
    await storage().delete(key); // simulate transient storage outage
    await drainQueue();
    const failed = await queryOne<{ status: string; attempts: number; error: string }>("SELECT status, attempts, error FROM ingestion_jobs WHERE id = $1", [r.jobId]);
    expect(failed).toMatchObject({ status: "queued", attempts: 1 });
    expect(failed!.error).toMatch(/Blob not found/);
    await storage().put(key, blob, "text/markdown");
    await query("UPDATE ingestion_jobs SET run_after = now() WHERE id = $1", [r.jobId]);
    await drainQueue();
    expect((await queryOne<{ status: string }>("SELECT status FROM ingestion_jobs WHERE id = $1", [r.jobId]))!.status).toBe("succeeded");
    const n = await queryOne<{ n: number; d: number }>("SELECT count(*)::int AS n, count(DISTINCT ord)::int AS d FROM document_chunks WHERE version_id = $1", [r.versionId]);
    expect(n!.n).toBe(n!.d);
  });

  it("deletes a document with its chunks, embeddings and stored original", async () => {
    const r = await createDocumentVersion({ workspaceId: commons, userId: null, filename: "del.md", data: Buffer.from("# Delete me\n\nSome content to delete.\n"), mimeType: "text/markdown", sourceType: "user_provided" });
    await drainQueue();
    const key = (await queryOne<{ storage_key: string }>("SELECT storage_key FROM document_versions WHERE id = $1", [r.versionId]))!.storage_key;
    await deleteDocument(r.documentId, null);
    const left = await queryOne<{ c: number; e: number; b: number }>(
      "SELECT (SELECT count(*)::int FROM document_chunks WHERE document_id = $1) AS c, (SELECT count(*)::int FROM embeddings) AS e, (SELECT count(*)::int FROM document_blobs WHERE storage_key = $2) AS b",
      [r.documentId, key],
    );
    expect(left).toEqual({ c: 0, e: 0, b: 0 });
  });
});

describe("retrieval, answers and access control", () => {
  beforeEach(async () => {
    await createDocumentVersion({ workspaceId: commons, userId: null, filename: "synthetic-spec.docx", data: fx("synthetic-spec.docx"), mimeType: "application/octet-stream", sourceType: "user_provided" });
    await drainQueue();
  }, 120_000);

  it("answers with verbatim quotes whose citations point at the source text", async () => {
    const { answer } = await ask("What does the UE send for widget attach and which timer starts?", { workspaceIds: [commons] });
    expect(answer.status).not.toBe("insufficient_evidence");
    const quotes = answer.summary;
    expect(quotes.length).toBeGreaterThan(0);
    for (const s of quotes) {
      const ev = answer.evidence.find((e) => e.n === s.citations[0]);
      expect(ev?.content).toContain(s.text);
    }
    expect(quotes.some((s) => s.text.includes("T3510"))).toBe(true);
  });

  it("finds exact clause and identifier matches", async () => {
    const r = await hybridSearch("Explain clause 4.1.2 of TS 99.999", { workspaceIds: [commons] });
    expect(r.channelCounts.clause).toBeGreaterThan(0);
    expect(r.evidence[0]!.clause).toBe("4.1.2");
    const t = await hybridSearch("WIDGET ATTACH REJECT", { workspaceIds: [commons] });
    expect(t.evidence[0]!.identifiers).toContain("msg:widgetattachreject");
  });

  it("refuses to invent answers for unknown terms and reports unindexed specs", async () => {
    const { answer } = await ask("What is the maximum bitrate of the QZX-9000 interface?", { workspaceIds: [commons] });
    expect(answer.status).toBe("insufficient_evidence");
    expect(answer.summary).toEqual([]);
    const { answer: a2 } = await ask("Explain clause 5.2 of TS 23.999", { workspaceIds: [commons] });
    expect(a2.gaps.join(" ")).toMatch(/23\.999 is not indexed/);
  });

  it("isolates personal workspaces and hides documents pending review", async () => {
    const alice = await registerUser("alice@example.com", "password-alice-1", "Alice");
    const bob = await registerUser("bob@example.com", "password-bob-12", "Bob");
    expect(alice.isAdmin).toBe(true);
    expect(bob.isAdmin).toBe(false);
    const alicePersonal = (await userWorkspaces(alice.id)).find((w) => w.kind === "personal")!;
    await createDocumentVersion({ workspaceId: alicePersonal.id, userId: alice.id, filename: "secret.md", data: Buffer.from("# Private\n\nThe zebra-quokka protocol uses timer T3599.\n"), mimeType: "text/markdown", sourceType: "user_provided" });
    const pending = await createDocumentVersion({ workspaceId: commons, userId: bob.id, filename: "pending.md", data: Buffer.from("# Pending\n\nThe walrus-otter procedure is pending review.\n"), mimeType: "text/markdown", sourceType: "user_provided", reviewStatus: "pending" });
    await drainQueue();
    const bobWs = await readableWorkspaceIds(bob);
    expect(bobWs).not.toContain(alicePersonal.id);
    expect(await readableWorkspaceIds(bob, [alicePersonal.id])).toEqual([]); // requested foreign workspace is dropped
    const bobSearch = await hybridSearch("zebra-quokka protocol", { workspaceIds: bobWs });
    expect(bobSearch.evidence.some((e) => e.content.includes("zebra-quokka"))).toBe(false);
    const aliceSearch = await hybridSearch("zebra-quokka protocol", { workspaceIds: await readableWorkspaceIds(alice) });
    expect(aliceSearch.evidence.some((e) => e.content.includes("zebra-quokka"))).toBe(true);
    expect((await hybridSearch("walrus-otter procedure", { workspaceIds: bobWs })).evidence.some((e) => e.content.includes("walrus-otter"))).toBe(false);
    await setReviewStatus(pending.documentId, "approved", alice.id);
    expect((await hybridSearch("walrus-otter procedure", { workspaceIds: bobWs })).evidence.some((e) => e.content.includes("walrus-otter"))).toBe(true);
  });
});
