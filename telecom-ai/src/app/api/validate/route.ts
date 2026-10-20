import { z } from "zod";
import YAML from "yaml";
import { route, json, requireUser, parseBody, limit } from "@/lib/http";
import { validateInstance, validateOpenApi } from "@/lib/openapi/validate";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("openapi"), document: z.string().min(1).max(5_000_000) }),
  z.object({ kind: z.literal("instance"), document: z.string().min(1).max(5_000_000), schemaName: z.string().min(1).max(200), instance: z.string().max(1_000_000) }),
  z.object({ kind: z.literal("json"), document: z.string().max(5_000_000) }),
  z.object({ kind: z.literal("yaml"), document: z.string().max(5_000_000) }),
]);

/** Validators run in-process on data only — nothing uploaded is ever executed. */
export const POST = route(async (req) => {
  const user = await requireUser();
  await limit(req, user, "validate", 60, 60);
  const b = await parseBody(req, Body);
  if (b.kind === "openapi") return json(validateOpenApi(b.document));
  if (b.kind === "instance") {
    let instance: unknown;
    try {
      instance = JSON.parse(b.instance);
    } catch (e) {
      return json({ valid: false, errors: [`Instance is not valid JSON: ${(e as Error).message}`], warnings: [], stats: {} });
    }
    return json(validateInstance(b.document, b.schemaName, instance));
  }
  try {
    if (b.kind === "json") JSON.parse(b.document);
    else YAML.parse(b.document);
    return json({ valid: true, errors: [], warnings: [], stats: {} });
  } catch (e) {
    return json({ valid: false, errors: [(e as Error).message], warnings: [], stats: {} });
  }
});
