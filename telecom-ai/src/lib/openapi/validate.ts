import Ajv from "ajv";
import { parseStructured, resolveLocalRef } from "../ingest/chunk/openapi";

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: Record<string, number | string>;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

/** Structural OpenAPI checks (3.0/3.1, Swagger 2.0 partially). Never fetches external $refs. */
export function validateOpenApi(text: string): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc: Json;
  try {
    doc = obj(parseStructured(text));
  } catch (e) {
    return { valid: false, errors: [`Parse error: ${(e as Error).message}`], warnings, stats: {} };
  }
  const version = String(doc.openapi ?? doc.swagger ?? "");
  if (!version) errors.push("Missing 'openapi' (or 'swagger') version field");
  else if (!/^(3\.[01]\.\d+|2\.0)$/.test(version)) warnings.push(`Unrecognised OpenAPI version ${version}`);
  const info = obj(doc.info);
  if (!info.title) errors.push("info.title is required");
  if (!info.version) errors.push("info.version is required");
  const paths = obj(doc.paths);
  if (!Object.keys(paths).length) warnings.push("No paths defined");
  const opIds = new Map<string, string>();
  let ops = 0;
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith("/")) errors.push(`Path '${path}' must start with '/'`);
    const pi = obj(item);
    const shared = Array.isArray(pi.parameters) ? pi.parameters.map((p) => obj(typeof obj(p).$ref === "string" ? resolveLocalRef(doc, String(obj(p).$ref)) : p)) : [];
    const templ = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    for (const m of METHODS) {
      const op = obj(pi[m]);
      if (!Object.keys(op).length) continue;
      ops++;
      const where = `${m.toUpperCase()} ${path}`;
      const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : []).map((p) => obj(typeof obj(p).$ref === "string" ? resolveLocalRef(doc, String(obj(p).$ref)) : p))];
      for (const t of templ) {
        const p = params.find((x) => x.in === "path" && x.name === t);
        if (!p) errors.push(`${where}: path parameter {${t}} is not declared`);
        else if (p.required !== true) errors.push(`${where}: path parameter '${t}' must have required: true`);
      }
      for (const p of params) {
        if (!["path", "query", "header", "cookie"].includes(String(p.in))) errors.push(`${where}: parameter '${String(p.name)}' has invalid location '${String(p.in)}'`);
        if (p.in === "path" && !templ.includes(String(p.name))) errors.push(`${where}: path parameter '${String(p.name)}' does not appear in the path template`);
        if (!p.schema && !p.content && version.startsWith("3")) warnings.push(`${where}: parameter '${String(p.name)}' has no schema`);
      }
      if (typeof op.operationId === "string") {
        if (opIds.has(op.operationId)) errors.push(`Duplicate operationId '${op.operationId}' (${opIds.get(op.operationId)} and ${where})`);
        opIds.set(op.operationId, where);
      } else warnings.push(`${where}: no operationId`);
      const responses = obj(op.responses);
      if (!Object.keys(responses).length) errors.push(`${where}: at least one response is required`);
      for (const code of Object.keys(responses)) if (!/^([1-5]\d\d|[1-5]XX|default)$/.test(code)) errors.push(`${where}: invalid response code '${code}'`);
      if (["get", "delete", "head"].includes(m) && op.requestBody) warnings.push(`${where}: request body on ${m.toUpperCase()} has undefined semantics`);
    }
  }
  const refs = { local: 0, external: 0, unresolved: [] as string[] };
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object")
      for (const [k, val] of Object.entries(v)) {
        if (k === "$ref" && typeof val === "string") {
          if (val.startsWith("#/")) {
            refs.local++;
            if (resolveLocalRef(doc, val) === undefined) refs.unresolved.push(val);
          } else refs.external++;
        } else walk(val);
      }
  };
  walk(doc);
  for (const u of [...new Set(refs.unresolved)].slice(0, 30)) errors.push(`Unresolved $ref ${u}`);
  if (refs.external) warnings.push(`${refs.external} external $ref(s) (e.g. TS29571_CommonData.yaml) were not fetched; validate those files separately.`);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: { openapi: version, operations: ops, schemas: Object.keys(obj(obj(doc.components).schemas)).length, localRefs: refs.local, externalRefs: refs.external },
  };
}

/** Validate a JSON instance against a named component schema of an OpenAPI document. */
export function validateInstance(openapiText: string, schemaName: string, instance: unknown): ValidationReport {
  let doc: Json;
  try {
    doc = obj(parseStructured(openapiText));
  } catch (e) {
    return { valid: false, errors: [`Parse error: ${(e as Error).message}`], warnings: [], stats: {} };
  }
  const schemas = obj(obj(doc.components).schemas);
  if (!schemas[schemaName]) return { valid: false, errors: [`Schema '${schemaName}' not found in components.schemas`], warnings: [], stats: {} };
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  // Register the document so local "#/components/schemas/X" references resolve; external refs are stubbed.
  const stubbed = JSON.parse(JSON.stringify(doc), (k, v) => (k === "$ref" && typeof v === "string" && !v.startsWith("#/") ? "#/__external" : v));
  stubbed.__external = {};
  ajv.addSchema(stubbed, "doc");
  const validate = ajv.compile({ $ref: `doc#/components/schemas/${schemaName}` });
  const ok = validate(instance) as boolean;
  const warnings = JSON.stringify(doc).includes('"$ref":"') && JSON.stringify(stubbed).includes("#/__external") ? ["External $refs were accepted without validation."] : [];
  return { valid: ok, errors: (validate.errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`), warnings, stats: { schema: schemaName } };
}
