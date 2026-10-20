import { query, queryOne } from "../db";
import { safeFetch } from "../security/ssrf";
import { compareVersions, inferSpecType, parseSpecFilename } from "../telecom/spec";
import { createDocumentVersion } from "../ingest/service";
import { sha256 } from "../ingest/hash";
import { heartbeat, jobEvent, type JobRow } from "../ingest/queue";
import { robotsAllows, USER_AGENT } from "./robots";
import { CancelledError } from "../ingest/pipeline";
import { errorMessage } from "../logger";

/** Specs from the platform brief: indexed first so the app is useful before the full corpus lands. */
export const PRIORITY_SPECS = new Set([
  "23.501", "23.502", "23.503", "29.500", "29.501", "29.502", "29.503", "29.504", "29.509", "29.510", "29.518", "29.571",
  "38.300", "38.401", "38.331", "38.413", "24.501", "29.244", "23.401", "23.402", "24.301", "36.300", "36.413", "29.274",
  "29.281", "33.501", "33.102", "23.228", "21.905", "29.512", "29.507", "29.513", "29.514", "29.272", "29.212",
]);

export interface ThreeGppConfig {
  series?: string[];
  specs?: string[]; // optional explicit allowlist, e.g. ["23.501", "23.502"]
  mode?: "latest_per_spec";
  concurrency?: number;
  delayMs?: number;
  limit?: number; // cap new versions per run
}

/** Parse an HTTP directory listing into child entry names (directories end with "/"). */
export function parseDirectoryListing(html: string, baseUrl: string): { name: string; url: string; isDir: boolean }[] {
  const base = new URL(baseUrl);
  const out = new Map<string, { name: string; url: string; isDir: boolean }>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#?]+)["']/gi)) {
    let abs: URL;
    try {
      abs = new URL(m[1]!, base);
    } catch {
      continue;
    }
    if (abs.origin !== base.origin || !abs.pathname.startsWith(base.pathname) || abs.pathname === base.pathname) continue;
    const rest = decodeURIComponent(abs.pathname.slice(base.pathname.length));
    if (!rest || rest.includes("/", 0) && !/^[^/]+\/$/.test(rest)) continue; // direct children only
    const isDir = rest.endsWith("/");
    const name = rest.replace(/\/$/, "");
    if (name === ".." || name === ".") continue;
    out.set(name, { name, url: abs.toString(), isDir });
  }
  return [...out.values()];
}

async function list(url: string) {
  const res = await safeFetch(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 60_000, userAgent: USER_AGENT, accept: "text/html" });
  if (res.status !== 200) throw new Error(`Listing ${url} failed: HTTP ${res.status}`);
  return parseDirectoryListing(res.body.toString("utf8"), url.endsWith("/") ? url : `${url}/`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function syncThreeGpp(job: JobRow, source: { id: string; workspace_id: string; url: string; config: ThreeGppConfig }) {
  const cfg = source.config;
  const base = source.url.endsWith("/") ? source.url : `${source.url}/`;
  if (!(await robotsAllows(base))) throw new Error(`robots.txt disallows ${base}`);
  const run = await queryOne<{ id: string }>("INSERT INTO source_sync_runs(source_id, status) VALUES ($1,'running') RETURNING id", [source.id]);
  const stats = { seriesListed: 0, specsSeen: 0, newVersions: 0, unchanged: 0, duplicates: 0, failed: 0, failures: [] as string[] };
  const wanted = new Set(cfg.specs ?? []);
  const delay = cfg.delayMs ?? 750;
  try {
    // 1) Enumerate spec directories per series.
    const specDirs: { spec: string; url: string }[] = [];
    for (const series of cfg.series ?? ["23"]) {
      const entries = await list(`${base}${series}_series/`);
      stats.seriesListed++;
      for (const e of entries) if (e.isDir && /^\d{2}\.\d{3}(-\d+)?$/.test(e.name) && (!wanted.size || wanted.has(e.name))) specDirs.push({ spec: e.name, url: e.url });
      await sleep(delay);
      if ((await heartbeat(job.id, `list ${series}_series`, 0.02)).cancel) throw new CancelledError("Cancelled by user");
    }
    // Priority specs first.
    specDirs.sort((a, b) => Number(PRIORITY_SPECS.has(b.spec)) - Number(PRIORITY_SPECS.has(a.spec)) || a.spec.localeCompare(b.spec));
    await jobEvent(job.id, "info", "list", `Found ${specDirs.length} specification directories`);

    // 2) For each spec, find the latest version file and register it if new.
    let idx = 0;
    const worker = async () => {
      while (idx < specDirs.length) {
        if (cfg.limit && stats.newVersions >= cfg.limit) return;
        const { spec, url } = specDirs[idx++]!;
        stats.specsSeen++;
        try {
          const files = (await list(url)).filter((f) => !f.isDir).map((f) => ({ ...f, info: parseSpecFilename(f.name) })).filter((f) => f.info && f.info.specNumber === spec);
          if (!files.length) continue;
          files.sort((a, b) => compareVersions(b.info!.version, a.info!.version));
          const latest = files[0]!;
          const docKey = `3gpp:${spec}`;
          const exists = await queryOne(
            `SELECT 1 FROM document_versions v JOIN documents d ON d.id = v.document_id
             WHERE d.workspace_id = $1 AND d.doc_key = $2 AND (v.original_filename = $3 OR v.version_label = $4) AND v.status <> 'failed'`,
            [source.workspace_id, docKey, latest.name, latest.info!.version],
          );
          if (exists) {
            stats.unchanged++;
            continue;
          }
          await sleep(delay);
          const dl = await safeFetch(latest.url, { maxBytes: 300 * 1024 * 1024, timeoutMs: 300_000, userAgent: USER_AGENT });
          if (dl.status !== 200) throw new Error(`HTTP ${dl.status}`);
          const type = inferSpecType(spec);
          const r = await createDocumentVersion({
            workspaceId: source.workspace_id,
            userId: null,
            filename: latest.name,
            data: process.env.THREEGPP_STORE_ORIGINALS === "true" ? dl.body : null,
            checksum: sha256(dl.body),
            byteSize: dl.body.length,
            mimeType: "application/zip",
            sourceType: type === "TR" ? "official_informative" : "official_normative",
            sourceId: source.id,
            sourceUrl: latest.url,
            docKey,
            reviewStatus: "approved",
            priority: PRIORITY_SPECS.has(spec) ? 2 : 6,
            metadata: { provenance: "3gpp_archive", listingUrl: url, retrievedAt: new Date().toISOString() },
          });
          if (r.duplicate) stats.duplicates++;
          else stats.newVersions++;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          stats.failed++;
          if (stats.failures.length < 50) stats.failures.push(`${spec}: ${errorMessage(err)}`);
          await jobEvent(job.id, "warn", "spec", `${spec}: ${errorMessage(err)}`);
        }
        const { cancel } = await heartbeat(job.id, `spec ${spec}`, 0.05 + 0.9 * (stats.specsSeen / specDirs.length));
        if (cancel) throw new CancelledError("Cancelled by user");
        await sleep(delay);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, cfg.concurrency ?? 2)) }, worker));
    await query("UPDATE source_sync_runs SET status = $2, stats = $3, finished_at = now() WHERE id = $1", [run!.id, stats.failed ? "partial" : "succeeded", stats]);
    await query("UPDATE document_sources SET last_synced_at = now() WHERE id = $1", [source.id]);
    return stats;
  } catch (err) {
    await query("UPDATE source_sync_runs SET status = 'failed', stats = $2, error = $3, finished_at = now() WHERE id = $1", [run!.id, stats, errorMessage(err)]);
    throw err;
  }
}
