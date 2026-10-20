import "./load-env";
import fs from "node:fs";
import path from "node:path";
import { closePool } from "../src/lib/db";
import { createDocumentVersion } from "../src/lib/ingest/service";
import { drainQueue } from "../src/lib/ingest/runner";
import { ensureCommonsWorkspace } from "../src/lib/sources/registry";
import { isSourceType } from "../src/lib/ingest/source-types";
import { terminateOcr } from "../src/lib/ingest/ocr";
import "../src/lib/ingest/handlers";

// Usage: npm run ingest:file -- <file...> [--source-type official_normative] [--no-drain]
const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--source-type"));
const stIdx = args.indexOf("--source-type");
const sourceType = stIdx >= 0 ? args[stIdx + 1]! : "user_provided";
if (!isSourceType(sourceType)) throw new Error(`Unknown source type ${sourceType}`);
const ws = await ensureCommonsWorkspace();
for (const f of files) {
  const data = fs.readFileSync(f);
  const r = await createDocumentVersion({ workspaceId: ws, userId: null, filename: path.basename(f), data, mimeType: "application/octet-stream", sourceType });
  console.log(r.duplicate ? `duplicate: ${f} (already ${r.duplicateOf?.title})` : `queued: ${f} -> job ${r.jobId}`);
}
if (!args.includes("--no-drain")) console.log(`processed ${await drainQueue()} job(s)`);
await terminateOcr();
await closePool();
