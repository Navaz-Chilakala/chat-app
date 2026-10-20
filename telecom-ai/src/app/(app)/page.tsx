"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { AnswerView } from "@/components/AnswerView";
import type { AnswerData } from "@/components/types";
import { Badge, ErrorNote, Spinner } from "@/components/ui";

interface Turn {
  id: string;
  question: string;
  stage: "searching" | "composing" | "done" | "error";
  evidenceCount?: number;
  answer?: AnswerData;
  messageId?: string;
  error?: string;
  latencyMs?: number;
}

const EXAMPLES = [
  "Trace a 5G registration procedure from UE to AMF",
  "How is a PDU session established?",
  "What is the difference between N2 and N3?",
  "Compare LTE attach with 5G registration",
  "What happens if authentication fails?",
  "Explain clause 4.2.2.2.2 of TS 23.502",
  "Which specification defines the PFCP Session Establishment Request?",
  "Find where the implementation handles NGAP Initial UE Message",
];

const TAGS = [
  { id: "lte", label: "LTE / EPC" },
  { id: "5gc", label: "5G Core" },
  { id: "ran", label: "Radio access" },
  { id: "security", label: "Security" },
  { id: "protocols", label: "Protocols" },
  { id: "ims", label: "IMS" },
];

export default function ChatPage() {
  const [conversations, setConversations] = useState<{ id: string; title: string; updated_at: string }[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [spec, setSpec] = useState("");
  const [release, setRelease] = useState("");
  const [officialOnly, setOfficialOnly] = useState(false);
  const [mode, setMode] = useState<"latest" | "historical">("latest");
  const [showHistory, setShowHistory] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(() => api<{ conversations: typeof conversations }>("/api/conversations").then((r) => setConversations(r.conversations)).catch(() => undefined), []);
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);
  // Deep link: /?q=... asks immediately (used by the Code Explorer).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) {
      window.history.replaceState(null, "", "/");
      void send(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Block body on purpose: newer browsers return a Promise from scrollIntoView, and an effect must not return
  // anything except a cleanup function (React would try to call the Promise on the next update).
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const openConversation = async (id: string) => {
    const r = await api<{ messages: { id: string; role: string; content: string; answer: AnswerData | null }[] }>(`/api/conversations/${id}`);
    const t: Turn[] = [];
    for (const m of r.messages) {
      if (m.role === "user") t.push({ id: m.id, question: m.content, stage: "done" });
      else if (t.length) Object.assign(t[t.length - 1]!, { answer: m.answer ?? undefined, messageId: m.id, stage: "done" });
    }
    setConversationId(id);
    setTurns(t);
    setShowHistory(false);
  };

  const filters = () => {
    const f: Record<string, unknown> = { mode };
    if (tags.length) f.tags = tags;
    const specs = spec.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^\d{2}\.\d{3}(-\d+)?$/.test(s));
    if (specs.length) f.specNumbers = specs;
    const rels = release.split(/[,\s]+/).map(Number).filter((n) => n >= 4 && n <= 25);
    if (rels.length) f.releases = rels;
    if (officialOnly) f.maxTier = 1;
    return f;
  };

  const send = async (question: string) => {
    if (!question.trim() || busy) return;
    setBusy(true);
    setError(null);
    const turn: Turn = { id: crypto.randomUUID(), question, stage: "searching" };
    setTurns((t) => [...t, turn]);
    setInput("");
    const update = (patch: Partial<Turn>) => setTurns((ts) => ts.map((x) => (x.id === turn.id ? { ...x, ...patch } : x)));
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: question, conversationId: conversationId ?? undefined, filters: filters() }) });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "meta") setConversationId(ev.conversationId);
          else if (ev.type === "evidence") update({ stage: "composing", evidenceCount: ev.evidence.length });
          else if (ev.type === "answer") update({ stage: "done", answer: ev.answer, messageId: ev.messageId, latencyMs: ev.latencyMs });
          else if (ev.type === "error") update({ stage: "error", error: ev.error });
        }
      }
      loadConversations();
    } catch (err) {
      update({ stage: "error", error: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-5">
      <aside className={`${showHistory ? "fixed inset-0 z-40 block bg-[var(--bg)] p-4" : "hidden"} w-64 shrink-0 xl:static xl:block xl:p-0`}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">Conversations</span>
          <div className="flex gap-1">
            <button className="btn !px-2 !py-1 text-xs" onClick={() => { setConversationId(null); setTurns([]); setShowHistory(false); }}>New chat</button>
            <button className="btn !px-2 !py-1 text-xs xl:hidden" onClick={() => setShowHistory(false)}>✕</button>
          </div>
        </div>
        <ul className="space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id}>
              <button onClick={() => openConversation(c.id)} className={`w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800 ${c.id === conversationId ? "bg-slate-100 dark:bg-slate-800" : ""}`}>
                <div className="truncate">{c.title}</div>
                <div className="muted text-[11px]">{fmtDate(c.updated_at)}</div>
              </button>
            </li>
          ))}
          {!conversations.length && <li className="muted px-2 text-xs">No conversations yet.</li>}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Ask the telecom knowledge base</h1>
          <Badge tone="green">no LLM · extractive answers with citations</Badge>
          <button className="btn ml-auto !px-2 !py-1 text-xs xl:hidden" onClick={() => setShowHistory(true)}>History</button>
        </div>

        <div className="flex-1 space-y-5 pb-4">
          {!turns.length && (
            <div className="panel p-5">
              <p className="muted text-sm">Questions are answered only with passages retrieved from indexed specifications, schemas, code and documents — quoted verbatim, with citations to spec, version and clause. When the knowledge base has no supporting text, the answer says so.</p>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {EXAMPLES.map((q) => (
                  <button key={q} onClick={() => send(q)} className="rounded-lg border hairline px-3 py-2 text-left text-sm hover:border-brand-500">{q}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t) => (
            <div key={t.id} className="space-y-3">
              <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2 text-sm text-white">{t.question}</div>
              <div className="panel p-4">
                {t.stage === "searching" && <div className="muted flex items-center gap-2 text-sm"><Spinner /> Searching exact identifiers, clauses, full text and vectors…</div>}
                {t.stage === "composing" && <div className="muted flex items-center gap-2 text-sm"><Spinner /> Found {t.evidenceCount} passages — composing an extractive answer…</div>}
                {t.stage === "error" && <ErrorNote error={t.error ?? "Error"} />}
                {t.answer && <AnswerView answer={t.answer} messageId={t.messageId} question={t.question} onRerun={() => send(t.question)} />}
                {t.latencyMs != null && <div className="muted mt-2 text-right text-[11px]">retrieval {t.latencyMs} ms</div>}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>

        <div className="sticky bottom-0 bg-[var(--bg)] pb-2 pt-2">
          <ErrorNote error={error} />
          {showFilters && (
            <div className="panel mb-2 grid gap-3 p-3 text-sm md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold">Domains</div>
                <div className="flex flex-wrap gap-1.5">
                  {TAGS.map((t) => (
                    <button key={t.id} onClick={() => setTags((x) => (x.includes(t.id) ? x.filter((y) => y !== t.id) : [...x, t.id]))} className={`rounded-full border px-2.5 py-0.5 text-xs ${tags.includes(t.id) ? "border-brand-500 bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100" : "hairline"}`}>{t.label}</button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs"><span className="mb-1 block font-semibold">Spec number(s)</span><input className="input" placeholder="23.502, 24.501" value={spec} onChange={(e) => setSpec(e.target.value)} /></label>
                <label className="text-xs"><span className="mb-1 block font-semibold">3GPP release(s)</span><input className="input" placeholder="17, 18" value={release} onChange={(e) => setRelease(e.target.value)} /></label>
              </div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={officialOnly} onChange={(e) => setOfficialOnly(e.target.checked)} /> Official 3GPP sources only (Tier 1)</label>
              <div className="flex items-center gap-3 text-xs">
                <span className="font-semibold">Mode</span>
                <label className="flex items-center gap-1"><input type="radio" checked={mode === "latest"} onChange={() => setMode("latest")} /> Latest applicable versions</label>
                <label className="flex items-center gap-1"><input type="radio" checked={mode === "historical"} onChange={() => setMode("historical")} /> Historical / release-specific</label>
              </div>
            </div>
          )}
          <form className="panel flex items-end gap-2 p-2" onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <button type="button" className={`btn !px-2.5 ${showFilters ? "!border-brand-500" : ""}`} onClick={() => setShowFilters((s) => !s)} title="Filters">⚙︎</button>
            <textarea
              className="max-h-40 min-h-[42px] flex-1 resize-y bg-transparent px-2 py-2 text-sm outline-none"
              placeholder="Ask about a procedure, clause, message, IE, timer, API operation or implementation…"
              value={input}
              rows={1}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            />
            <button className="btn btn-primary" disabled={busy || !input.trim()}>{busy ? <Spinner /> : "Ask"}</button>
          </form>
        </div>
      </div>
    </div>
  );
}
