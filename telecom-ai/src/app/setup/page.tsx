import { redirect } from "next/navigation";
import { envStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Shown only while required configuration is missing (e.g. a fresh deployment without DATABASE_URL). */
export default function SetupPage() {
  const s = envStatus();
  if (s.ok) redirect("/login");
  const missing = s.problems.map((p) => p.split(":")[0]);
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Setup required</h1>
      <p className="muted mt-2 text-sm">This deployment is running, but required server configuration is missing, so no data can be stored or searched yet.</p>
      <div className="panel mt-6 p-4 text-sm">
        <div className="font-medium">Missing or invalid environment variables:</div>
        <ul className="mt-2 list-disc pl-5 font-mono text-xs">{missing.map((m) => <li key={m}>{m}</li>)}</ul>
        <p className="muted mt-4">Set them in your hosting provider (see <code>.env.example</code> and <code>docs/DEPLOYMENT.md</code>) and redeploy — environment changes only apply to new deployments. Values are never displayed here.</p>
      </div>
    </main>
  );
}
