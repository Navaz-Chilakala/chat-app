import { route, json, requireUser, requireAdmin } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { query } from "@/lib/db";
import { runEvaluation } from "@/lib/eval/run";

export const maxDuration = 300;

export const GET = route(async () => {
  await requireUser();
  const cases = await query("SELECT name, category, query, expected, notes FROM evaluation_cases ORDER BY category, name");
  const runs = await query("SELECT id, started_at, finished_at, metrics, results FROM evaluation_runs ORDER BY started_at DESC LIMIT 10");
  return json({ cases, runs });
});

export const POST = route(async () => {
  const admin = await requireAdmin();
  return json(await runEvaluation(await readableWorkspaceIds(admin)));
});
