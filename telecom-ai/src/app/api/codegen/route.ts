import { z } from "zod";
import { route, json, requireUser, parseBody, HttpError } from "@/lib/http";
import { query, queryOne } from "@/lib/db";
import { generate, type Target } from "@/lib/openapi/codegen";

const Body = z.object({
  versionId: z.string().uuid(),
  operationIds: z.array(z.string().uuid()).max(200).optional(),
  target: z.enum(["typescript-client", "python-client", "python-fastapi", "go-structs"]),
});

export const POST = route(async (req) => {
  const user = await requireUser();
  const b = await parseBody(req, Body);
  const v = await queryOne<{ title: string; version_label: string | null; workspace_id: string }>(
    `SELECT d.title, v.version_label, d.workspace_id FROM document_versions v JOIN documents d ON d.id = v.document_id
     JOIN workspace_memberships m ON m.workspace_id = d.workspace_id AND m.user_id = $2 WHERE v.id = $1`,
    [b.versionId, user.id],
  );
  if (!v) throw new HttpError(404, "API document not found");
  const ops = await query<{ id: string; method: string; path: string; operation_id: string | null; summary: string | null; parameters: Record<string, unknown>[]; request_body: Record<string, unknown> | null; responses: Record<string, unknown>; api_title: string; api_version: string | null; chunk_id: string }>(
    "SELECT * FROM api_operations WHERE version_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY path, method",
    [b.versionId, b.operationIds ?? null],
  );
  if (!ops.length) throw new HttpError(400, "No operations selected");
  const schemas = await query<{ name: string; schema: Record<string, unknown> }>("SELECT name, schema FROM api_schemas WHERE version_id = $1 ORDER BY name", [b.versionId]);
  const ids = await queryOne<{ identifiers: string[] }>("SELECT identifiers FROM document_chunks WHERE id = $1", [ops[0]!.chunk_id]);
  const files = generate(
    {
      apiTitle: ops[0]!.api_title,
      apiVersion: ops[0]!.api_version,
      specRefs: (ids?.identifiers ?? []).filter((i) => i.startsWith("spec:")).map((i) => `3GPP TS ${i.slice(5)}`),
      sourceLabel: `${v.title}${v.version_label ? ` (${v.version_label})` : ""}`,
      operations: ops.map((o) => ({ method: o.method, path: o.path, operationId: o.operation_id, summary: o.summary, parameters: o.parameters, requestBody: o.request_body, responses: o.responses })),
      schemas,
    },
    b.target as Target,
  );
  return json({
    files,
    provenance: { versionId: b.versionId, document: v.title, version: v.version_label, operations: ops.length, schemas: schemas.length },
    verification: "Generated from the indexed schema by a deterministic template. Not compiled or executed on the server; run the type checker / tests locally. Standards compliance is not implied.",
  });
});
