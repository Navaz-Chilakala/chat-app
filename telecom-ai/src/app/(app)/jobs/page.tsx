"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, fmtBytes, fmtDate } from "@/lib/client";
import { Card, ErrorNote, PageHeader, StatusBadge, Empty } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function JobsPage() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<string>("");
  const [selected, setSelected] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<{ jobs: any[]; counts: { status: string; n: number }[] }>(`/api/jobs${filter ? `?status=${filter}` : ""}`)
      .then((r) => { setJobs(r.jobs); setCounts(Object.fromEntries(r.counts.map((c) => [c.status, c.n]))); })
      .catch((e) => setError(e.message));
  }, [filter]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  const open = async (id: string) => setSelected(await api(`/api/jobs/${id}`));
  return (
    <div>
      <PageHeader title="Ingestion jobs" subtitle="Background jobs run in the worker, independent of your browser session. Failed jobs retry automatically with backoff; you can also retry or cancel them here." />
      <ErrorNote error={error} />
      <div className="mb-3 flex flex-wrap gap-1.5">
        {["", "queued", "running", "succeeded", "failed", "cancelled"].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`rounded-full border px-3 py-1 text-xs ${filter === s ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100" : "hairline"}`}>
            {s || "all"} {s && counts[s] != null ? `(${counts[s]})` : ""}
          </button>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="muted text-xs"><tr><th className="py-2 pr-3">Job</th><th className="pr-3">Status</th><th className="pr-3">Stage</th><th className="pr-3">Attempts</th><th>Created</th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className={`cursor-pointer border-t hairline hover:bg-slate-50 dark:hover:bg-slate-800/40 ${selected?.job?.id === j.id ? "bg-slate-50 dark:bg-slate-800/40" : ""}`} onClick={() => open(j.id)}>
                    <td className="max-w-[320px] py-2 pr-3">
                      <div className="truncate font-medium">{j.title ?? j.original_filename ?? j.source_name ?? j.kind}</div>
                      <div className="muted text-xs">{j.kind}{j.byte_size ? ` · ${fmtBytes(j.byte_size)}` : ""}</div>
                    </td>
                    <td className="pr-3"><StatusBadge status={j.status} /></td>
                    <td className="pr-3 text-xs">{j.status === "running" ? `${j.stage ?? ""} ${Math.round((j.progress ?? 0) * 100)}%` : j.stage ?? "—"}</td>
                    <td className="pr-3 text-xs tabular-nums">{j.attempts}/{j.max_attempts}</td>
                    <td className="muted text-xs">{fmtDate(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!jobs.length && <Empty>No jobs.</Empty>}
          </div>
        </Card>
        <Card className="xl:col-span-2" title="Job detail">
          {!selected ? (
            <div className="muted text-sm">Select a job to see its event log.</div>
          ) : (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><StatusBadge status={selected.job.status} /><span className="font-mono text-xs">{selected.job.id}</span></div>
              {selected.job.error && <ErrorNote error={selected.job.error} />}
              <div className="flex flex-wrap gap-2">
                {["failed", "cancelled"].includes(selected.job.status) && <button className="btn !py-1 text-xs" onClick={async () => { await api(`/api/jobs/${selected.job.id}/retry`, { method: "POST" }); open(selected.job.id); load(); }}>Retry safely</button>}
                {["queued", "running"].includes(selected.job.status) && <button className="btn btn-danger !py-1 text-xs" onClick={async () => { await api(`/api/jobs/${selected.job.id}/cancel`, { method: "POST" }); open(selected.job.id); load(); }}>Cancel</button>}
                {selected.job.document_version_id && jobs.find((j) => j.id === selected.job.id)?.document_id && <Link className="btn !py-1 text-xs" href={`/documents/${jobs.find((j) => j.id === selected.job.id)?.document_id}`}>Document</Link>}
              </div>
              {Object.keys(selected.job.result ?? {}).length > 0 && <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs dark:bg-slate-800/60">{JSON.stringify(selected.job.result, null, 2)}</pre>}
              <ol className="max-h-[520px] space-y-1 overflow-y-auto font-mono text-[11.5px]">
                {selected.events.map((e: any) => (
                  <li key={e.id} className={e.level === "error" ? "text-red-600" : e.level === "warn" ? "text-amber-700 dark:text-amber-300" : ""}>
                    <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span> [{e.stage ?? "-"}] {e.message}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
