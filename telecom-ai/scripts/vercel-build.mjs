// Vercel build: apply migrations when a database is configured, then build Next.js.
// Without DATABASE_URL the app still builds and serves the /setup page.
import { execSync } from "node:child_process";

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
if (process.env.DATABASE_URL) {
  console.log("DATABASE_URL present — applying migrations");
  run("npx tsx scripts/migrate.ts");
} else {
  console.log("DATABASE_URL not set — skipping migrations (the app will show the setup page)");
}
run("npx next build");
