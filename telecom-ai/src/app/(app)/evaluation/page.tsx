"use client";

import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Badge, Card, ErrorNote, PageHeader, Spinner, Stat, Empty } from "@/components/ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function EvaluationPage() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api("/api/eval").then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const latest = data?.runs?.[0];
  const m = latest?.metrics ?? {};
  const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  return (
    <div>
      <PageHeader
        title="Evaluation"
        subtitle="Curated retrieval cases checked against what is actually indexed. Cases whose specification is not indexed are reported as skipped — never counted as passes."
        actions={<button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await api("/api/eval", { method: "POST" }); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? <Spinner /> : "Run evaluation (admin)"}</button>}
      />
      <ErrorNote error={error} />
      {latest ? (
        <>
          <div className="muted mb-2 text-xs">Latest run {fmtDate(latest.finished_at ?? latest.started_at)}</div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Evaluated" value={`${m.evaluated ?? 0}/${m.cases ?? 0}`} hint={`${m.skipped ?? 0} skipped`} />
            <Stat label="Passed" value={m.passed ?? 0} />
            <Stat label="Recall@5" value={pct(m.recallAt5)} />
            <Stat label="Recall@10" value={pct(m.recallAt10)} />
            <Stat label="MRR" value={m.mrr ?? "—"} />
            <Stat label="nDCG@10" value={m.ndcgAt10 ?? "—"} />
            <Stat label="Citation faithfulness" value={pct(m.citationFaithfulness)} hint="quotes found verbatim in cited source" />
            <Stat label="Refusal accuracy" value={pct(m.refusalAccuracy)} hint="unanswerable / injection" />
          </div>
          <Card className="mt-4" title="Per-case results">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="muted text-xs"><tr><th className="py-2 pr-3">Case</th><th className="pr-3">Category</th><th className="pr-3">Result</th><th className="pr-3">Rank</th><th className="pr-3">nDCG</th><th className="pr-3">Faithful</th><th>Notes</th></tr></thead>
                <tbody>
                  {latest.results.map((r: any) => (
                    <tr key={r.name} className="border-t hairline">
                      <td className="py-2 pr-3"><div className="font-medium">{r.name}</div><div className="muted text-xs">{r.query}</div></td>
                      <td className="pr-3 text-xs">{r.category}</td>
                      <td className="pr-3"><Badge tone={r.status === "pass" ? "green" : r.status === "fail" ? "red" : "gray"}>{r.status}</Badge></td>
                      <td className="pr-3 tabular-nums">{r.rank ?? "—"}</td>
                      <td className="pr-3 tabular-nums">{r.ndcgAt10 != null ? r.ndcgAt10.toFixed(2) : "—"}</td>
                      <td className="pr-3 tabular-nums">{pct(r.citationFaithfulness)}</td>
                      <td className="muted text-xs">{r.reason ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : <Empty>No evaluation runs yet.</Empty>}
      <Card className="mt-4" title={`Cases (${data?.cases?.length ?? 0})`}>
        <ul className="grid gap-2 text-sm md:grid-cols-2">
          {(data?.cases ?? []).map((c: any) => (
            <li key={c.name} className="rounded-lg border hairline p-2.5">
              <div className="flex items-center gap-2"><span className="font-medium">{c.name}</span><Badge>{c.category}</Badge></div>
              <div className="muted text-xs">{c.query}</div>
              <code className="text-[11px]">{JSON.stringify(c.expected)}</code>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
