// Vercel build: apply migrations when a database is configured, then build Next.js.
// Without DATABASE_URL the app still builds and serves the /setup page.
import { execSync } from "node:child_process";

const run = (cmd, env = process.env) => execSync(cmd, { stdio: "inherit", env });
if (process.env.DATABASE_URL) {
  // Migrations take a session-level advisory lock, so prefer a direct (non-pooled) connection when the
  // provider supplies one (Neon: DATABASE_URL_UNPOOLED; Vercel Postgres: POSTGRES_URL_NON_POOLING).
  const direct = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
  console.log(`DATABASE_URL present — applying migrations (${direct === process.env.DATABASE_URL ? "pooled" : "direct"} connection)`);
  run("npx tsx scripts/migrate.ts", { ...process.env, DATABASE_URL: direct });
} else {
  console.log("DATABASE_URL not set — skipping migrations (the app will show the setup page)");
}
run("npx next build");
