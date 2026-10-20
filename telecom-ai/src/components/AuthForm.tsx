"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { ErrorNote, Spinner } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form
        className="panel w-full max-w-sm p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(mode === "login" ? "/api/auth/login" : "/api/auth/signup", { body: mode === "login" ? { email, password } : { email, password, displayName } });
            router.push("/");
            router.refresh();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-5 flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">TK</div>
          <div>
            <h1 className="text-lg font-semibold">{mode === "login" ? "Sign in" : "Create account"}</h1>
            <p className="muted text-xs">Telecom Knowledge — 3GPP, LTE/EPC, 5G Core</p>
          </div>
        </div>
        <div className="space-y-3">
          {mode === "signup" && (
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Name</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} autoComplete="name" />
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Password</span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "signup" ? 10 : 1} autoComplete={mode === "login" ? "current-password" : "new-password"} />
            {mode === "signup" && <span className="muted mt-1 block text-xs">At least 10 characters. The first account becomes the administrator.</span>}
          </label>
          <ErrorNote error={error} />
          <button className="btn btn-primary w-full justify-center" disabled={busy}>{busy && <Spinner />} {mode === "login" ? "Sign in" : "Create account"}</button>
        </div>
        <p className="muted mt-4 text-center text-xs">
          {mode === "login" ? <>No account? <Link className="text-brand-600 underline" href="/signup">Create one</Link></> : <>Have an account? <Link className="text-brand-600 underline" href="/login">Sign in</Link></>}
        </p>
      </form>
    </main>
  );
}
