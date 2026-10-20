import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { query, queryOne } from "../db";
import { createDocumentVersion } from "../ingest/service";
import { heartbeat, jobEvent, type JobRow } from "../ingest/queue";
import { languageForPath } from "../ingest/chunk/code";
import { validateUrlShape } from "../security/ssrf";
import { CancelledError, PermanentError } from "../ingest/pipeline";
import { isSourceType } from "../ingest/source-types";

const run = promisify(execFile);
const DOC_EXT = /\.(md|markdown|txt|rst|adoc|html?|pdf|ya?ml|json|asn1?|proto)$/i;
const SKIP_DIRS = /(^|\/)(\.git|node_modules|vendor|third_party|build|dist|out|target|\.venv|__pycache__|testdata\/large)(\/|$)/;

export function detectLicense(text: string): string | null {
  const t = text.slice(0, 4000);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return "AGPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 3/i.test(t)) return "GPL-3.0";
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,200}Version 2/i.test(t)) return "GPL-2.0";
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return "LGPL";
  if (/Apache License[\s\S]{0,100}Version 2\.0/i.test(t)) return "Apache-2.0";
  if (/MIT License|Permission is hereby granted, free of charge/i.test(t)) return "MIT";
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(t)) return "BSD";
  if (/OAI Public License/i.test(t)) return "OAI-PL-1.1";
  if (/Mozilla Public License/i.test(t)) return "MPL-2.0";
  return null;
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(/*turbopackIgnore: true*/ root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP_DIRS.test(p)) continue;
    if (e.isDirectory()) out.push(...(await walk(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export interface GitConfig {
  ref?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

/** Shallow-clone an approved repository and index its source, docs and API definitions at one commit. */
export async function syncGitRepo(job: JobRow, source: { id: string; workspace_id: string; url: string; config: GitConfig; license: string | null; source_type: string }) {
  validateUrlShape(source.url, { allowedPorts: [443] });
  const cfg = source.config;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-"));
  const runRow = await queryOne<{ id: string }>("INSERT INTO source_sync_runs(source_id, status) VALUES ($1,'running') RETURNING id", [source.id]);
  const stats = { files: 0, queued: 0, unchanged: 0, skipped: 0, removedUpstream: 0, commit: "" };
  try {
    const args = ["clone", "--depth", "1", "--single-branch", "--no-tags"];
    if (cfg.ref) args.push("--branch", cfg.ref);
    args.push("--", source.url, dir);
    try {
      await run("git", args, { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    } catch (err) {
      const msg = (err as Error).message;
      if (/ENOENT/.test(msg)) throw new PermanentError("git is not installed on this worker (repository ingestion requires the container worker)");
      throw new Error(`git clone failed: ${msg.split("\n").slice(-3).join(" ")}`);
    }
    const commit = (await run("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
    stats.commit = commit;
    const ref = cfg.ref ?? (await run("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    const seen = await queryOne("SELECT 1 FROM repository_snapshots WHERE source_id = $1 AND commit_sha = $2", [source.id, commit]);
    if (seen) {
      await jobEvent(job.id, "info", "git", `Commit ${commit.slice(0, 12)} already indexed; nothing to do`);
      await query("UPDATE source_sync_runs SET status = 'succeeded', stats = $2, finished_at = now() WHERE id = $1", [runRow!.id, { ...stats, unchangedCommit: true }]);
      return { ...stats, unchangedCommit: true };
    }
    let license = source.license;
    for (const lf of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
      const text = await fs.readFile(path.join(/*turbopackIgnore: true*/ dir, lf), "utf8").catch(() => null);
      if (text) {
        license = detectLicense(text) ?? license;
        break;
      }
    }
    const include = (cfg.include ?? []).map((r) => new RegExp(r));
    const exclude = (cfg.exclude ?? []).map((r) => new RegExp(r));
    const all = (await walk(dir)).filter((p) => (languageForPath(p) || DOC_EXT.test(p)) && (!include.length || include.some((r) => r.test(p))) && !exclude.some((r) => r.test(p)));
    // Spend the file budget on what matters first: docs, then hand-written source, then vendored/generated code.
    const rank = (p: string) =>
      /(^|\/)(readme|contributing|architecture)[^/]*$|(^|\/)docs?\//i.test(p) ? 0
      : /(^|\/)(ext|external|extern|3rdparty|third[-_]party|deps|vendor)\//i.test(p) ? 3
      : /(^|\/)(asn|asn1c|generated|gen|autogen)\//i.test(p) ? 4
      : /(^|\/)(test|tests|testdata)\//i.test(p) ? 2
      : 1;
    all.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const files = all.slice(0, cfg.maxFiles ?? 6000);
    if (all.length > files.length) await jobEvent(job.id, "warn", "git", `${all.length - files.length} lower-priority file(s) (vendored/generated) beyond maxFiles=${cfg.maxFiles ?? 6000} were not indexed`);
    const sourceType = isSourceType(source.source_type) ? source.source_type : "reference_implementation";
    const paths = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      const rel = files[i]!;
      const stat = await fs.stat(path.join(/*turbopackIgnore: true*/ dir, rel));
      if (stat.size > (cfg.maxFileBytes ?? 400_000) || stat.size === 0) {
        stats.skipped++;
        continue;
      }
      stats.files++;
      paths.add(rel);
      const data = await fs.readFile(path.join(/*turbopackIgnore: true*/ dir, rel));
      const r = await createDocumentVersion({
        workspaceId: source.workspace_id,
        userId: null,
        filename: path.basename(rel),
        data,
        mimeType: "text/plain",
        sourceType,
        sourceId: source.id,
        sourceUrl: source.url,
        docKey: `repo:${source.url}:${rel}`,
        title: `${source.url.replace(/^https:\/\/|\.git$/g, "")} : ${rel}`,
        versionLabel: commit.slice(0, 12),
        commitSha: commit,
        repoPath: rel,
        license,
        language: languageForPath(rel),
        priority: 7,
        metadata: { repo: source.url, ref, commit, path: rel, retrievedAt: new Date().toISOString() },
      });
      if (r.duplicate) stats.unchanged++;
      else stats.queued++;
      if (i % 50 === 0 && (await heartbeat(job.id, `files ${i}/${files.length}`, i / files.length)).cancel) throw new CancelledError("Cancelled by user");
    }
    // Files that disappeared upstream stay in version history but stop being searchable.
    const docs = await query<{ id: string; doc_key: string }>("SELECT id, doc_key FROM documents WHERE source_id = $1", [source.id]);
    const prefix = `repo:${source.url}:`;
    const gone = docs.filter((d) => d.doc_key.startsWith(prefix) && !paths.has(d.doc_key.slice(prefix.length))).map((d) => d.id);
    if (gone.length) {
      await query("UPDATE documents SET tags = array_append(tags, 'removed-upstream') WHERE id = ANY($1) AND NOT 'removed-upstream' = ANY(tags)", [gone]);
      await query("UPDATE document_chunks SET searchable = false WHERE document_id = ANY($1)", [gone]);
      stats.removedUpstream = gone.length;
    }
    await query("INSERT INTO repository_snapshots(source_id, repo_url, ref, commit_sha, license, file_count) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [source.id, source.url, ref, commit, license, stats.files]);
    await query("UPDATE source_sync_runs SET status = 'succeeded', stats = $2, finished_at = now() WHERE id = $1", [runRow!.id, stats]);
    await query("UPDATE document_sources SET last_synced_at = now(), license = COALESCE($2, license) WHERE id = $1", [source.id, license]);
    return stats;
  } catch (err) {
    await query("UPDATE source_sync_runs SET status = 'failed', stats = $2, error = $3, finished_at = now() WHERE id = $1", [runRow!.id, stats, (err as Error).message]);
    throw err;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
