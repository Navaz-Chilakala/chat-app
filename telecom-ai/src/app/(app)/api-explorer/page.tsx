"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Empty } from "@/components/ui";
import { CodeBlock } from "@/components/CodeBlock";

/* eslint-disable @typescript-eslint/no-explicit-any */
const TARGETS = [
  { id: "typescript-client", label: "TypeScript client" },
  { id: "python-client", label: "Python client (httpx)" },
  { id: "python-fastapi", label: "FastAPI server stub" },
  { id: "go-structs", label: "Go structs" },
];

export default function ApiExplorerPage() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [ops, setOps] = useState<any[]>([]);
  const [apis, setApis] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [gen, setGen] = useState<any>(null);
  const [target, setTarget] = useState("typescript-client");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [valDoc, setValDoc] = useState("");
  const [valSchema, setValSchema] = useState("");
  const [valInstance, setValInstance] = useState("");
  const [valRes, setValRes] = useState<any>(null);

  const search = () => api<{ operations: any[]; apis: any[] }>(`/api/api-ops?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}${method ? `&method=${method}` : ""}`).then((r) => { setOps(r.operations); setApis(r.apis); }).catch((e) => setError(e.message));
  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async (versionId: string, operationIds?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      setGen(await api("/api/codegen", { body: { versionId, operationIds, target } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="API Explorer" subtitle="Structurally parsed OpenAPI definitions: search by operationId, path, method or response code; inspect request/response models; generate clients deterministically; validate documents and payloads." />
      <ErrorNote error={error} />
      <Card>
        <form className="grid gap-2 md:grid-cols-[1fr_120px_120px_auto]" onSubmit={(e) => { e.preventDefault(); search(); }}>
          <input className="input" placeholder="operationId, path fragment, API title or tag (e.g. NFRegister, /nf-instances)" value={q} onChange={(e) => setQ(e.target.value)} />
          <input className="input" placeholder="Status (404)" value={status} onChange={(e) => setStatus(e.target.value)} />
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="">Any method</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
          </select>
          <button className="btn btn-primary">Search</button>
        </form>
        {apis.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {apis.map((a) => <Badge key={a.version_id} tone="blue">{a.api_title} {a.api_version} · {a.operations} ops</Badge>)}
          </div>
        )}
      </Card>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title={`Operations (${ops.length})`}>
          {ops.length ? (
            <ul className="max-h-[560px] space-y-1 overflow-y-auto">
              {ops.map((o) => (
                <li key={o.id}>
                  <button className={`w-full rounded-md border px-2.5 py-2 text-left text-sm ${selected?.operation?.id === o.id ? "border-brand-500" : "hairline"}`} onClick={async () => setSelected(await api(`/api/api-ops/${o.id}`))}>
                    <div className="flex flex-wrap items-center gap-1.5"><Badge tone="blue">{o.method}</Badge><code className="text-xs">{o.path}</code>{o.deprecated && <Badge tone="red">deprecated</Badge>}</div>
                    <div className="muted mt-0.5 text-xs">{o.operation_id ?? "no operationId"} · {o.api_title} {o.api_version} · {(o.response_codes ?? []).join(", ")}</div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>No API operations indexed. Upload an OpenAPI YAML/JSON (e.g. TS29510_Nnrf_NFManagement.yaml) or sync the 3GPP 5G_APIs source.</Empty>}
        </Card>
        <Card title="Operation detail">
          {!selected ? <div className="muted text-sm">Select an operation.</div> : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5"><Badge tone="blue">{selected.operation.method}</Badge><code>{selected.operation.path}</code></div>
              <div><b>operationId:</b> {selected.operation.operation_id ?? "—"} · <b>API:</b> {selected.operation.api_title} {selected.operation.api_version} (OpenAPI {selected.operation.openapi_version})</div>
              {selected.operation.summary && <div>{selected.operation.summary}</div>}
              <div className="muted text-xs">Source: <Link className="underline" href={`/documents/${selected.operation.document_id}?chunk=${selected.operation.chunk_id}`}>{selected.operation.document_title} {selected.operation.version_label}</Link>{(selected.operation.identifiers ?? []).filter((i: string) => i.startsWith("spec:")).map((i: string) => ` · defined in TS ${i.slice(5)}`)}</div>
              <div>
                <div className="mb-1 text-xs font-semibold">Parameters</div>
                {selected.operation.parameters?.length ? (
                  <ul className="space-y-0.5 text-xs">{selected.operation.parameters.map((p: any, i: number) => <li key={i}><code>{p.name}</code> · {p.in}{p.required ? " · required" : " · optional"} · {p.schema?.$ref?.split("/").pop() ?? p.schema?.type ?? "—"}{p.description ? ` — ${p.description}` : ""}</li>)}</ul>
                ) : <div className="muted text-xs">none</div>}
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold">Responses</div>
                <ul className="space-y-0.5 text-xs">{Object.entries(selected.operation.responses ?? {}).map(([code, r]: any) => <li key={code}><Badge tone={code.startsWith("2") ? "green" : code.startsWith("4") || code.startsWith("5") ? "red" : "gray"}>{code}</Badge> {r?.description ?? r?.$ref?.split("/").pop() ?? ""}</li>)}</ul>
              </div>
              {selected.operation.security && <div className="text-xs"><b>Security:</b> <code>{JSON.stringify(selected.operation.security)}</code></div>}
              {selected.schemas.map((s: any) => (
                <details key={s.name} className="rounded border hairline p-2 text-xs">
                  <summary className="cursor-pointer font-semibold">Schema {s.name} {s.required?.length ? `(required: ${s.required.join(", ")})` : ""}</summary>
                  <pre className="mt-1 max-h-64 overflow-auto">{JSON.stringify(s.schema, null, 2)}</pre>
                </details>
              ))}
              <div className="flex flex-wrap items-center gap-2 border-t hairline pt-3">
                <select className="input !w-auto" value={target} onChange={(e) => setTarget(e.target.value)}>{TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
                <button className="btn" onClick={() => generate(selected.operation.version_id, [selected.operation.id])}>Generate for this operation</button>
                <button className="btn btn-primary" onClick={() => generate(selected.operation.version_id)}>Generate for whole API</button>
                {busy && <Spinner />}
              </div>
            </div>
          )}
        </Card>
      </div>
      {gen && (
        <Card className="mt-4" title={`Generated code — ${gen.provenance.document} ${gen.provenance.version ?? ""} (${gen.provenance.operations} operations, ${gen.provenance.schemas} schemas)`}>
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">{gen.verification}</p>
          <div className="space-y-3">{gen.files.map((f: any) => <CodeBlock key={f.path} code={f.content} language={f.language} title={f.path} />)}</div>
        </Card>
      )}
      <Card className="mt-4" title="Validators (run on data only — nothing is executed)">
        <div className="grid gap-3 lg:grid-cols-2">
          <textarea className="input min-h-48 font-mono text-xs" placeholder="Paste an OpenAPI document (YAML or JSON)…" value={valDoc} onChange={(e) => setValDoc(e.target.value)} />
          <div className="space-y-2">
            <input className="input" placeholder="Component schema name (for payload validation)" value={valSchema} onChange={(e) => setValSchema(e.target.value)} />
            <textarea className="input min-h-28 font-mono text-xs" placeholder='JSON payload to validate, e.g. {"nfInstanceId": "...", "nfType": "AMF"}' value={valInstance} onChange={(e) => setValInstance(e.target.value)} />
            <div className="flex gap-2">
              <button className="btn" disabled={!valDoc} onClick={async () => setValRes(await api("/api/validate", { body: { kind: "openapi", document: valDoc } }))}>Validate OpenAPI</button>
              <button className="btn" disabled={!valDoc || !valSchema || !valInstance} onClick={async () => setValRes(await api("/api/validate", { body: { kind: "instance", document: valDoc, schemaName: valSchema, instance: valInstance } }))}>Validate payload</button>
            </div>
            {valRes && (
              <div className="text-xs">
                <Badge tone={valRes.valid ? "green" : "red"}>{valRes.valid ? "valid" : "invalid"}</Badge>
                {Object.entries(valRes.stats ?? {}).map(([k, v]) => <span key={k} className="muted ml-2">{k}: {String(v)}</span>)}
                {valRes.errors.length > 0 && <ul className="mt-1 list-disc pl-5 text-red-700 dark:text-red-300">{valRes.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
                {valRes.warnings.length > 0 && <ul className="mt-1 list-disc pl-5 text-amber-700 dark:text-amber-300">{valRes.warnings.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
