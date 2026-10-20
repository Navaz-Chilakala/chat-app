import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/http";
import { env } from "@/lib/env";
import { drainQueue } from "@/lib/ingest/runner";
import "@/lib/ingest/handlers";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Vercel Cron fallback processor for SMALL jobs only (URL fetches, small text/markdown/code/OpenAPI files,
 * deletions). PDFs/DOCX with OCR, 3GPP archive syncs and git repositories always go to the container worker.
 */
export async function GET(req: NextRequest) {
  const secret = env().CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (!secret || auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const processed = await drainQueue({
    workerId: "vercel-cron",
    budgetMs: 240_000,
    maxBytes: env().CRON_MAX_JOB_BYTES,
    kinds: ["fetch_url", "delete_document", "index_version"],
    maxJobs: 50,
    lightOnly: true,
  });
  return json({ processed });
}
