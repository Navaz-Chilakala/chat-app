"use client";

/** Small JSON fetch helper for client components. Throws Error(message) with the server's error text. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body || init.form ? "POST" : "GET"),
    headers: init.form ? undefined : init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function fmtBytes(n: number | null | undefined): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
