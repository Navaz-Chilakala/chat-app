"use client";

import { useState, type ReactNode } from "react";

const TONES: Record<string, string> = {
  gray: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  blue: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  green: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  violet: "bg-violet-50 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
};

export function Badge({ children, tone = "gray", title }: { children: ReactNode; tone?: keyof typeof TONES | string; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap ${TONES[tone] ?? TONES.gray}`}>
      {children}
    </span>
  );
}

export const TIER_LABEL: Record<number, { label: string; tone: string }> = {
  1: { label: "Tier 1 · Official 3GPP", tone: "green" },
  2: { label: "Tier 2 · Official schema/SDO", tone: "blue" },
  3: { label: "Tier 3 · Reference impl.", tone: "violet" },
  4: { label: "Tier 4 · Secondary/user", tone: "amber" },
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  official_normative: "Normative standard",
  official_informative: "Informative report",
  official_schema: "Official schema",
  standards_body: "SDO publication",
  reference_implementation: "Reference implementation",
  vendor: "Vendor-specific",
  academic: "Academic",
  educational: "Educational",
  user_provided: "User-provided",
  unverified: "Unverified",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const tone = status === "indexed" || status === "succeeded" || status === "approved" || status === "active" ? "green" : status === "failed" || status === "rejected" ? "red" : status === "running" || status === "processing" ? "blue" : status === "pending" || status === "queued" || status === "paused" ? "amber" : "gray";
  return <Badge tone={tone}>{status ?? "—"}</Badge>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="muted mt-1 max-w-3xl text-sm">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="panel p-4">
      <div className="muted text-xs font-medium uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="muted mt-1 text-xs">{hint}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted rounded-lg border border-dashed hairline p-6 text-center text-sm">{children}</div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn !px-2 !py-1 text-xs"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent align-[-2px]" aria-label="Loading" />;
}
