import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  EMBEDDING_PROVIDER: z.enum(["local-hash", "openai-compatible"]).default("local-hash"),
  EMBEDDING_API_URL: z.string().optional().default(""),
  EMBEDDING_API_KEY: z.string().optional().default(""),
  EMBEDDING_MODEL: z.string().optional().default(""),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  EMBEDDING_COST_PER_1M_TOKENS: z.coerce.number().nonnegative().default(0),
  STORAGE_DRIVER: z.enum(["db", "s3", "local"]).default("db"),
  STORAGE_LOCAL_DIR: z.string().default(".data/blobs"),
  S3_BUCKET: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("auto"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
  URL_INGEST_ALLOWED_HOSTS: z.string().optional().default(""),
  CRON_MAX_JOB_BYTES: z.coerce.number().nonnegative().default(3_000_000),
  CRON_SECRET: z.string().optional().default(""),
  GITHUB_TOKEN: z.string().optional().default(""),
  SIGNUP_MODE: z.enum(["open", "invite"]).default("open"),
  ALLOWED_SIGNUP_EMAILS: z.string().optional().default(""),
  ADMIN_USERNAME: z.string().trim().max(80).optional().default(""),
  ADMIN_PASSWORD: z.string().max(200).optional().default(""),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Validated server-side configuration. Throws a readable error listing every invalid variable. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Non-throwing check used by health/setup pages. */
export function envStatus(): { ok: boolean; problems: string[] } {
  const parsed = schema.safeParse(process.env);
  return parsed.success
    ? { ok: true, problems: [] }
    : { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function resetEnvCache() {
  cached = null;
}
