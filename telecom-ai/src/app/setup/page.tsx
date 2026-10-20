import { envStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Shown when required configuration is missing (e.g. a fresh Vercel deployment without DATABASE_URL). */
export default function SetupPage() {
  const s = envStatus();
  const missing = s.problems.map((p) => p.split(":")[0]);
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Setup required</h1>
      <p className="muted mt-2 text-sm">This deployment is running, but required server configuration is missing, so no data can be stored or searched yet.</p>
      {s.ok ? (
        <p className="mt-6 text-sm">Configuration looks complete. <a className="text-brand-600 underline" href="/login">Continue to sign in</a>.</p>
      ) : (
        <div className="panel mt-6 p-4 text-sm">
          <div className="font-medium">Missing or invalid environment variables:</div>
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
          <p className="muted mt-4">Set them in your hosting provider (see <code>.env.example</code> and <code>docs/DEPLOYMENT.md</code>), run the database migrations, and redeploy. Values are never displayed here.</p>
        </div>
      )}
    </main>
  );
}
