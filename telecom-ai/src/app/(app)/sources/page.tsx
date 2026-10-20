"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, SOURCE_TYPE_LABEL, StatusBadge, TIER_LABEL } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function SourcesPage() {
  const [sources, setSources] = useState<any[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "git_repo", name: "", url: "", sourceType: "reference_implementation", license: "", ref: "" });
  const load = () => api<{ sources: any[] }>("/api/sources").then((r) => setSources(r.sources)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<{ user: { isAdmin: boolean } }>("/api/auth/me").then((r) => setIsAdmin(r.user.isAdmin));
  }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    try {
      await fn();
      setMsg(ok);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div>
      <PageHeader title="Source registry" subtitle="Every source records its authority tier, trust level, access method, licence and sync status. New sources start paused and must be activated by an administrator." />
      <ErrorNote error={error} />
      {msg && <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{msg}</div>}
      <div className="space-y-3">
        {sources.map((s) => (
          <Card key={s.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{s.name}</span>
                  <Badge tone={TIER_LABEL[s.authority_tier]?.tone}>{TIER_LABEL[s.authority_tier]?.label}</Badge>
                  <Badge>{SOURCE_TYPE_LABEL[s.source_type] ?? s.source_type}</Badge>
                  <Badge tone="gray">{s.kind}</Badge>
                  <StatusBadge status={s.status} />
                </div>
                <div className="muted mt-1 break-all text-xs">{s.url}</div>
                <div className="muted mt-1 text-xs">Access: {s.access_method} · Trust: {s.trust_level} · Licence: {s.license ?? "unknown"} · Documents: {s.document_count} · Sync every {s.sync_interval_hours ? `${s.sync_interval_hours} h` : "— (manual)"}</div>
                <div className="muted text-xs">Last sync: {fmtDate(s.last_synced_at)}{s.last_run ? ` — ${s.last_run.status}${s.last_run.error ? `: ${s.last_run.error}` : ""}` : ""}</div>
                {s.last_run?.stats && <pre className="mt-1 max-w-full overflow-x-auto text-[11px] muted">{JSON.stringify(s.last_run.stats)}</pre>}
              </div>
              {isAdmin && (
                <div className="flex flex-wrap gap-1.5">
                  {s.status !== "active" && <button className="btn !py-1 text-xs" onClick={() => act(() => api(`/api/sources/${s.id}`, { method: "PATCH", body: { status: "active" } }), "Source activated")}>Approve / activate</button>}
                  {s.status === "active" && <button className="btn !py-1 text-xs" onClick={() => act(() => api(`/api/sources/${s.id}`, { method: "PATCH", body: { status: "paused" } }), "Source paused")}>Pause</button>}
                  {s.status === "active" && <button className="btn btn-primary !py-1 text-xs" onClick={() => act(() => api(`/api/sources/${s.id}/sync`, { method: "POST" }), "Sync job queued — the worker will process it. See Ingestion Jobs.")}>Sync now</button>}
                  <button className="btn btn-danger !py-1 text-xs" onClick={() => act(() => api(`/api/sources/${s.id}`, { method: "PATCH", body: { status: "disabled" } }), "Source disabled; its documents are no longer searchable")}>Disable</button>
                  <Link className="btn !py-1 text-xs" href={`/jobs`}>Jobs</Link>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
      {isAdmin && (
        <Card className="mt-5" title="Register a source">
          <form
            className="grid gap-3 md:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => api("/api/sources", { body: { kind: form.kind, name: form.name, url: form.url, sourceType: form.sourceType, license: form.license || undefined, config: form.ref ? { ref: form.ref } : {} } }), "Source registered (paused) — activate it to sync");
            }}
          >
            <select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="git_repo">Git repository</option>
              <option value="url">URL (single document)</option>
              <option value="3gpp_archive">3GPP archive (series subset)</option>
            </select>
            <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input className="input" placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required />
            <select className="input" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
              {Object.entries(SOURCE_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input className="input" placeholder="Licence (e.g. Apache-2.0)" value={form.license} onChange={(e) => setForm({ ...form, license: e.target.value })} />
            <input className="input" placeholder="Branch / tag (git)" value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} />
            <button className="btn btn-primary w-fit">Register</button>
          </form>
        </Card>
      )}
    </div>
  );
}
