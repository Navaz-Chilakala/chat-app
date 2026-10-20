import YAML from "yaml";
import type { ChunkDraft, ChunkResult, StructuredApiOperation, StructuredApiSchema } from "../types";
import { makeChunk } from "./common";

type Json = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"] as const;

export function parseStructured(text: string): unknown {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(text);
  return YAML.parse(text, { maxAliasCount: 200 });
}

export function isOpenApiDocument(doc: unknown): doc is Json {
  return !!doc && typeof doc === "object" && ("openapi" in (doc as Json) || "swagger" in (doc as Json)) && "paths" in (doc as Json);
}

function asObj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

/** Resolve a local JSON pointer ("#/components/schemas/X"). External refs are never fetched. */
export function resolveLocalRef(root: Json, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = asObj(cur)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

/** Human-readable type description of a schema, without inlining whole referenced trees. */
export function describeSchema(schema: unknown, root: Json, depth = 0): string {
  const s = asObj(schema);
  if (typeof s.$ref === "string") {
    const external = !s.$ref.startsWith("#/");
    return external ? `${refName(s.$ref)} (external: ${s.$ref.split("#")[0]})` : refName(s.$ref);
  }
  if (Array.isArray(s.allOf)) return s.allOf.map((x) => describeSchema(x, root, depth + 1)).join(" & ");
  if (Array.isArray(s.oneOf)) return `oneOf(${s.oneOf.map((x) => describeSchema(x, root, depth + 1)).join(" | ")})`;
  if (Array.isArray(s.anyOf)) return `anyOf(${s.anyOf.map((x) => describeSchema(x, root, depth + 1)).join(" | ")})`;
  if (s.type === "array") return `array<${describeSchema(s.items, root, depth + 1)}>`;
  if (Array.isArray(s.enum)) return `enum(${s.enum.slice(0, 20).map(String).join(", ")}${s.enum.length > 20 ? ", …" : ""})`;
  if (s.type === "object" && depth < 1 && s.properties) return `object{${Object.keys(asObj(s.properties)).slice(0, 12).join(", ")}}`;
  const fmt = typeof s.format === "string" ? `:${s.format}` : "";
  return `${String(s.type ?? "any")}${fmt}`;
}

function specRefsFromText(t: string): string[] {
  return [...t.matchAll(/3GPP\s+(TS|TR)\s+(\d{2}\.\d{3})(?:\s+V(\d+\.\d+\.\d+))?/g)].map((m) => `${m[1]} ${m[2]}${m[3] ? ` V${m[3]}` : ""}`);
}

export function chunkOpenApi(doc: Json, sourceLabel: string): ChunkResult {
  const info = asObj(doc.info);
  const apiTitle = String(info.title ?? sourceLabel);
  const apiVersion = info.version != null ? String(info.version) : null;
  const openapiVersion = String(doc.openapi ?? doc.swagger ?? "");
  const extDocs = asObj(doc.externalDocs);
  const specRefs = specRefsFromText(`${String(info.description ?? "")}\n${String(extDocs.description ?? "")}`);
  const globalSecurity = doc.security ?? null;
  const servers = doc.servers ?? null;
  const warnings: string[] = [];
  const chunks: ChunkDraft[] = [];
  const apiOperations: StructuredApiOperation[] = [];
  const apiSchemas: StructuredApiSchema[] = [];
  let ord = 0;
  const header = `API: ${apiTitle}${apiVersion ? ` (version ${apiVersion})` : ""} — OpenAPI ${openapiVersion}${specRefs.length ? `\nDefined in: ${specRefs.join("; ")}` : ""}`;
  const docIds = specRefs.map((r) => `spec:${r.split(" ")[1]}`);
  const sections = [
    { key: "api", parentKey: null, clause: null, heading: apiTitle, level: 1, ord: 0, pageStart: null, pageEnd: null },
    { key: "ops", parentKey: "api", clause: null, heading: "Operations", level: 2, ord: 1, pageStart: null, pageEnd: null },
    { key: "schemas", parentKey: "api", clause: null, heading: "Schemas", level: 2, ord: 2, pageStart: null, pageEnd: null },
  ];

  // Overview chunk.
  const pathCount = Object.keys(asObj(doc.paths)).length;
  chunks.push(
    makeChunk({
      ord: ord++,
      chunkType: "api_overview",
      sectionKey: "api",
      headingPath: apiTitle,
      content: `${header}\n${String(info.description ?? "").slice(0, 1500)}\nPaths: ${pathCount}. Servers: ${JSON.stringify(servers ?? []).slice(0, 400)}\nSecurity schemes: ${Object.keys(asObj(asObj(doc.components).securitySchemes)).join(", ") || "none declared"}`,
      identifiers: docIds,
    }),
  );

  const resolveParam = (p: unknown): Json => {
    const o = asObj(p);
    return typeof o.$ref === "string" ? asObj(resolveLocalRef(doc, o.$ref)) : o;
  };
  const resolveResponse = (r: unknown): Json => {
    const o = asObj(r);
    return typeof o.$ref === "string" ? { ...asObj(resolveLocalRef(doc, o.$ref)), $refName: refName(o.$ref) } : o;
  };

  for (const [path, item] of Object.entries(asObj(doc.paths))) {
    const pathItem = asObj(item);
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of METHODS) {
      const op = asObj(pathItem[method]);
      if (!Object.keys(op).length) continue;
      const params = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(resolveParam);
      const reqBody = asObj(typeof asObj(op.requestBody).$ref === "string" ? resolveLocalRef(doc, String(asObj(op.requestBody).$ref)) : op.requestBody);
      const responses = asObj(op.responses);
      const operationId = typeof op.operationId === "string" ? op.operationId : null;
      const lines: string[] = [header, `Operation: ${method.toUpperCase()} ${path}${operationId ? ` (operationId: ${operationId})` : ""}`];
      if (op.summary) lines.push(`Summary: ${String(op.summary)}`);
      if (op.description) lines.push(`Description: ${String(op.description).slice(0, 1200)}`);
      if (op.deprecated) lines.push("DEPRECATED");
      if (params.length) {
        lines.push("Parameters:");
        for (const p of params) {
          lines.push(`- ${String(p.name)} (in ${String(p.in)}${p.required ? ", required" : ", optional"}): ${describeSchema(p.schema ?? asObj(asObj(p.content)["application/json"]).schema, doc)}${p.description ? ` — ${String(p.description).slice(0, 200)}` : ""}`);
        }
      }
      if (Object.keys(reqBody).length) {
        const content = asObj(reqBody.content);
        lines.push(`Request body (${reqBody.required ? "required" : "optional"}):`);
        for (const [ct, media] of Object.entries(content)) lines.push(`- ${ct}: ${describeSchema(asObj(media).schema, doc)}`);
      }
      lines.push("Responses:");
      for (const [code, resp] of Object.entries(responses)) {
        const r = resolveResponse(resp);
        const media = Object.entries(asObj(r.content)).map(([ct, m]) => `${ct}: ${describeSchema(asObj(m).schema, doc)}`);
        lines.push(`- ${code}${r.$refName ? ` (${String(r.$refName)})` : ""}: ${String(r.description ?? "").slice(0, 160)}${media.length ? ` [${media.join("; ")}]` : ""}`);
      }
      const security = op.security ?? globalSecurity;
      if (security) lines.push(`Security: ${JSON.stringify(security)}`);
      if (op.callbacks) lines.push(`Callbacks: ${Object.keys(asObj(op.callbacks)).join(", ")}`);
      const ids = [
        ...docIds,
        `path:${path.toLowerCase()}`,
        `http:${method}`,
        ...Object.keys(responses).map((c) => `http:${c.toLowerCase()}`),
        ...(operationId ? [`op:${operationId.toLowerCase()}`, `msg:${operationId.toLowerCase()}`] : []),
      ];
      const chunkOrd = ord++;
      chunks.push(
        makeChunk({
          ord: chunkOrd,
          chunkType: "api_operation",
          sectionKey: "ops",
          headingPath: `${apiTitle} > ${method.toUpperCase()} ${path}`,
          symbol: operationId,
          content: lines.join("\n"),
          identifiers: ids,
          metadata: { method: method.toUpperCase(), path, operationId, apiTitle, apiVersion },
        }),
      );
      apiOperations.push({
        chunkOrd,
        apiTitle,
        apiVersion,
        openapiVersion,
        method: method.toUpperCase(),
        path,
        operationId,
        summary: typeof op.summary === "string" ? op.summary : null,
        tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
        parameters: params,
        requestBody: Object.keys(reqBody).length ? reqBody : null,
        responses,
        security,
        servers,
        deprecated: !!op.deprecated,
      });
    }
  }

  const schemas = asObj(asObj(doc.components).schemas ?? doc.definitions);
  for (const [name, raw] of Object.entries(schemas)) {
    const s = asObj(raw);
    const required = Array.isArray(s.required) ? s.required.map(String) : [];
    const lines = [header, `Schema: ${name}`, `Type: ${describeSchema({ ...s, properties: undefined }, doc)}`];
    if (s.description) lines.push(`Description: ${String(s.description).slice(0, 800)}`);
    const props = asObj(s.properties);
    if (Object.keys(props).length) {
      lines.push("Properties:");
      for (const [pn, ps] of Object.entries(props)) {
        const p = asObj(ps);
        lines.push(`- ${pn}${required.includes(pn) ? " (required)" : ""}: ${describeSchema(p, doc, 1)}${p.description ? ` — ${String(p.description).slice(0, 160)}` : ""}`);
      }
    }
    for (const k of ["allOf", "oneOf", "anyOf"] as const) if (Array.isArray(s[k])) lines.push(`${k}: ${(s[k] as unknown[]).map((x) => describeSchema(x, doc)).join(", ")}`);
    if (Array.isArray(s.enum)) lines.push(`Enum values: ${s.enum.map(String).join(", ")}`);
    if (s.nullable) lines.push("Nullable: true");
    const chunkOrd = ord++;
    const content = lines.join("\n");
    chunks.push(
      makeChunk({
        ord: chunkOrd,
        chunkType: "api_schema",
        sectionKey: "schemas",
        headingPath: `${apiTitle} > Schema ${name}`,
        symbol: name,
        content: content.length > 6000 ? `${content.slice(0, 6000)}\n…(truncated; see original document)` : content,
        identifiers: [...docIds, `schema:${name.toLowerCase()}`, `msg:${name.toLowerCase()}`],
        metadata: { schemaName: name, apiTitle, apiVersion },
      }),
    );
    apiSchemas.push({ chunkOrd, name, schema: s, required });
  }

  // Validation findings reported as warnings (also surfaced by the validator API).
  const opIds = apiOperations.map((o) => o.operationId).filter(Boolean);
  const dup = opIds.filter((id, i) => opIds.indexOf(id) !== i);
  if (dup.length) warnings.push(`Duplicate operationIds: ${[...new Set(dup)].join(", ")}`);
  const unresolved = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        if (k === "$ref" && typeof val === "string" && val.startsWith("#/") && resolveLocalRef(doc, val) === undefined) unresolved.add(val);
        else walk(val);
      }
    }
  };
  walk(doc);
  if (unresolved.size) warnings.push(`Unresolved local $ref: ${[...unresolved].slice(0, 20).join(", ")}`);
  for (const o of apiOperations) if (!Object.keys(o.responses).length) warnings.push(`${o.method} ${o.path} declares no responses`);
  return { strategy: "openapi-structural", sections, chunks, apiOperations, apiSchemas, warnings };
}
