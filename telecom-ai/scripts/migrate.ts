import "./load-env";
import { migrate } from "../src/lib/migrate";
import { closePool } from "../src/lib/db";

const applied = await migrate();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
await closePool();
