"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/client";

const NAV = [
  { href: "/", label: "Chat", icon: "💬" },
  { href: "/knowledge", label: "Knowledge Base", icon: "📚" },
  { href: "/upload", label: "Upload", icon: "⬆️" },
  { href: "/sources", label: "Sources", icon: "🗂️" },
  { href: "/jobs", label: "Ingestion Jobs", icon: "⚙️" },
  { href: "/search", label: "Search", icon: "🔎" },
  { href: "/flows", label: "Call Flows", icon: "🔀" },
  { href: "/api-explorer", label: "API Explorer", icon: "🧩" },
  { href: "/code", label: "Code Explorer", icon: "💻" },
  { href: "/evaluation", label: "Evaluation", icon: "📈" },
  { href: "/settings", label: "Settings", icon: "🛠️" },
];

export function Shell({ user, children }: { user: { displayName: string; email: string; isAdmin: boolean }; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  useEffect(() => {
    setOpen(false);
  }, [path]);
  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* storage unavailable */
    }
    setDark(next);
  };
  const nav = user.isAdmin ? [...NAV, { href: "/admin", label: "Admin", icon: "🛡️" }] : NAV;
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const sidebar = (
    <nav className="flex h-full flex-col bg-ink-950 text-slate-300">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">TK</div>
        <div>
          <div className="text-sm font-semibold text-white">Telecom Knowledge</div>
          <div className="text-[11px] text-slate-400">Evidence-grounded retrieval</div>
        </div>
      </div>
      <ul className="flex-1 space-y-0.5 overflow-y-auto px-2">
        {nav.map((n) => (
          <li key={n.href}>
            <Link href={n.href} className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm ${isActive(n.href) ? "bg-ink-800 text-white" : "hover:bg-ink-900 hover:text-white"}`}>
              <span aria-hidden className="w-5 text-center">{n.icon}</span>
              {n.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="border-t border-ink-800 p-3 text-xs">
        <div className="truncate font-medium text-slate-200">{user.displayName}</div>
        <div className="truncate text-slate-500">{user.email}{user.isAdmin ? " · admin" : ""}</div>
        <div className="mt-2 flex gap-2">
          <button className="rounded border border-ink-800 px-2 py-1 hover:bg-ink-900" onClick={toggleTheme}>{dark ? "Light" : "Dark"} mode</button>
          <button
            className="rounded border border-ink-800 px-2 py-1 hover:bg-ink-900"
            onClick={async () => {
              await api("/api/auth/logout", { method: "POST" });
              router.push("/login");
              router.refresh();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal>
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b hairline bg-[var(--panel)] px-4 py-2.5 lg:hidden">
          <button className="btn !px-2 !py-1" onClick={() => setOpen(true)} aria-label="Open navigation">☰</button>
          <span className="text-sm font-semibold">Telecom Knowledge</span>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
