"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, fmtBytes } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, StatusBadge } from "@/components/ui";

interface Item {
  key: string;
  file: File;
  state: "ready" | "uploading" | "queued" | "duplicate" | "error";
  message?: string;
  jobId?: string | null;
  documentId?: string;
  job?: { status: string; stage: string | null; progress: number; error: string | null; result: Record<string, unknown> };
}

const ACCEPT = ".pdf,.docx,.doc,.txt,.md,.markdown,.html,.htm,.csv,.json,.yaml,.yml,.xml,.zip,.ts,.tsx,.js,.py,.go,.c,.h,.cpp,.hpp,.java,.kt,.rs,.sh,.sql,.proto,.asn,.asn1,.toml";

export default function UploadPage() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; kind: string; role: string }[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [sourceType, setSourceType] = useState("user_provided");
  const [items, setItems] = useState<Item[]>([]);
  const [drag, setDrag] = useState(false);
  const [urls, setUrls] = useState("");
  const [urlResults, setUrlResults] = useState<{ url: string; ok: boolean; error?: string; jobId?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ user: { isAdmin: boolean }; workspaces: typeof workspaces }>("/api/auth/me").then((r) => {
      setWorkspaces(r.workspaces);
      setIsAdmin(r.user.isAdmin);
      setWorkspaceId(r.workspaces[0]?.id ?? "");
    });
  }, []);

  // Poll job status for queued items until each reaches a terminal state.
  useEffect(() => {
    const pending = items.filter((i) => i.jobId && (!i.job || ["queued", "running"].includes(i.job.status)));
    if (!pending.length) return;
    const t = setTimeout(async () => {
      const updates = await Promise.all(pending.map((i) => api<{ job: Item["job"] }>(`/api/jobs/${i.jobId}`).then((r) => [i.key, r.job] as const).catch(() => null)));
      setItems((xs) => xs.map((x) => {
        const u = updates.find((p) => p && p[0] === x.key);
        return u ? { ...x, job: u[1] } : x;
      }));
    }, 2000);
    return () => clearTimeout(t);
  }, [items]);

  const add = (files: FileList | File[]) => setItems((xs) => [...xs, ...Array.from(files).map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, state: "ready" as const }))]);
  const ws = workspaces.find((w) => w.id === workspaceId);

  const upload = async () => {
    setError(null);
    const ready = items.filter((i) => i.state === "ready");
    for (let i = 0; i < ready.length; i += 5) {
      const batch = ready.slice(i, i + 5);
      setItems((xs) => xs.map((x) => (batch.some((b) => b.key === x.key) ? { ...x, state: "uploading" } : x)));
      const form = new FormData();
      form.set("workspaceId", workspaceId);
      form.set("sourceType", sourceType);
      for (const b of batch) form.append("files", b.file, b.file.name);
      try {
        const r = await api<{ results: { filename: string; ok: boolean; error?: string; duplicate?: boolean; jobId?: string | null; documentId?: string; reviewStatus?: string; duplicateOf?: { title: string } }[] }>("/api/documents/upload", { form });
        setItems((xs) =>
          xs.map((x) => {
            const idx = batch.findIndex((b) => b.key === x.key);
            if (idx < 0) return x;
            const res = r.results[idx];
            if (!res) return { ...x, state: "error", message: "No result" };
            if (!res.ok) return { ...x, state: "error", message: res.error };
            if (res.duplicate) return { ...x, state: "duplicate", message: `Identical file already indexed as “${res.duplicateOf?.title}” — no new embeddings created`, documentId: res.documentId };
            return { ...x, state: "queued", jobId: res.jobId, documentId: res.documentId, message: res.reviewStatus === "pending" ? "Awaiting reviewer approval before it becomes searchable" : undefined };
          }),
        );
      } catch (err) {
        setError((err as Error).message);
        setItems((xs) => xs.map((x) => (batch.some((b) => b.key === x.key) ? { ...x, state: "error", message: (err as Error).message } : x)));
      }
    }
  };

  return (
    <div>
      <PageHeader title="Upload documents" subtitle="PDF (with OCR for scanned pages and figures), DOCX/DOC, 3GPP zip deliverables, HTML, Markdown, text, CSV, OpenAPI/JSON/YAML, ASN.1 and source code. Files are stored durably, then indexed by the background worker." />
      <ErrorNote error={error} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Files">
          <div className="mb-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className="mb-1 block text-xs font-semibold">Workspace</span>
              <select className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role})</option>)}
              </select>
            </label>
            <label className="text-sm"><span className="mb-1 block text-xs font-semibold">Source type</span>
              <select className="input" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
                <option value="user_provided">User-provided material</option>
                <option value="educational">Educational article</option>
                <option value="academic">Academic research</option>
                <option value="vendor">Vendor-specific documentation</option>
                <option value="reference_implementation">Reference implementation</option>
                {isAdmin && <option value="official_normative">Official normative standard (admin)</option>}
                {isAdmin && <option value="official_informative">Official informative report (admin)</option>}
                {isAdmin && <option value="official_schema">Official schema (admin)</option>}
              </select>
            </label>
          </div>
          {ws?.kind === "shared" && ws.role === "viewer" && !isAdmin && <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">Uploads to the shared Commons are reviewed by an owner before they become searchable.</p>}
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
            onClick={() => input.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center text-sm ${drag ? "border-brand-500 bg-brand-50/50 dark:bg-brand-700/10" : "hairline"}`}
          >
            <div className="font-medium">Drop files here or click to choose</div>
            <div className="muted mt-1 text-xs">Multiple files supported · duplicates are detected by checksum</div>
            <input ref={input} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => e.target.files && add(e.target.files)} />
          </div>
          {items.length > 0 && (
            <div className="mt-4 space-y-2">
              {items.map((i) => (
                <div key={i.key} className="rounded-lg border hairline p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0"><div className="truncate font-medium">{i.file.name}</div><div className="muted text-xs">{fmtBytes(i.file.size)}</div></div>
                    <div className="flex items-center gap-2">
                      {i.job ? <StatusBadge status={i.job.status} /> : <Badge tone={i.state === "error" ? "red" : i.state === "duplicate" ? "amber" : "gray"}>{i.state}</Badge>}
                      {i.documentId && <Link className="text-xs underline" href={`/documents/${i.documentId}`}>Document</Link>}
                      {i.state === "ready" && <button className="btn !px-2 !py-1 text-xs" onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}>Remove</button>}
                    </div>
                  </div>
                  {i.job && ["queued", "running"].includes(i.job.status) && (
                    <div className="mt-2">
                      <div className="h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"><div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.round((i.job.progress ?? 0) * 100)}%` }} /></div>
                      <div className="muted mt-1 text-xs">Stage: {i.job.stage ?? "waiting for worker"}</div>
                    </div>
                  )}
                  {i.job?.status === "succeeded" && <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">Searchable · {String(i.job.result?.chunks ?? "?")} chunks · {String(i.job.result?.sections ?? "?")} sections{i.job.result?.pages ? ` · ${String(i.job.result.pages)} pages` : ""}{Number(i.job.result?.warnings ?? 0) ? ` · ${String(i.job.result.warnings)} warning(s) — see document` : ""}</div>}
                  {i.job?.status === "failed" && <div className="mt-1 text-xs text-red-700 dark:text-red-300">{i.job.error} — <Link className="underline" href="/jobs">retry from Jobs</Link></div>}
                  {i.message && <div className="muted mt-1 text-xs">{i.message}</div>}
                </div>
              ))}
              <div className="flex gap-2">
                <button className="btn btn-primary" disabled={!workspaceId || !items.some((i) => i.state === "ready")} onClick={upload}>Upload {items.filter((i) => i.state === "ready").length} file(s)</button>
                <button className="btn" onClick={() => setItems((xs) => xs.filter((x) => x.state === "ready" || (x.job && ["queued", "running"].includes(x.job.status))))}>Clear finished</button>
              </div>
            </div>
          )}
        </Card>
        <Card title="Ingest from URL">
          <p className="muted mb-2 text-xs">Public documents and articles only. Private networks, loopback and cloud-metadata addresses are blocked; robots.txt is respected; redirects are re-validated.</p>
          <textarea className="input min-h-28 font-mono text-xs" placeholder={"https://example.org/article.html\nhttps://example.org/spec.pdf"} value={urls} onChange={(e) => setUrls(e.target.value)} />
          <button
            className="btn btn-primary mt-2"
            disabled={!urls.trim() || !workspaceId}
            onClick={async () => {
              try {
                const r = await api<{ results: typeof urlResults }>("/api/urls", { body: { urls: urls.split(/\s+/).filter(Boolean), workspaceId, sourceType: sourceType === "user_provided" ? "unverified" : sourceType } });
                setUrlResults(r.results);
                setUrls("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Queue URLs
          </button>
          <ul className="mt-3 space-y-1 text-xs">{urlResults.map((r) => <li key={r.url} className={r.ok ? "" : "text-red-700 dark:text-red-300"}>{r.ok ? "✓" : "✕"} {r.url} {r.error && `— ${r.error}`}</li>)}</ul>
        </Card>
      </div>
    </div>
  );
}
