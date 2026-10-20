import { route, json, requireUser } from "@/lib/http";
import { readableWorkspaceIds } from "@/lib/auth/access";
import { CURATED_FLOWS } from "@/lib/flows/catalog";
import { curatedFlow } from "@/lib/flows/build";

export const GET = route(async () => {
  const user = await requireUser();
  const ws = await readableWorkspaceIds(user);
  const flows = [];
  for (const f of CURATED_FLOWS) {
    const built = await curatedFlow(f.title, f.generation, ws);
    flows.push({ id: f.id, title: f.title, generation: f.generation, spec: f.spec, clause: f.clause, verification: built?.verification ?? null });
  }
  return json({ flows });
});
