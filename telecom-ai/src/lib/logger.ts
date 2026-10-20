type Level = "debug" | "info" | "warn" | "error";

/** Structured JSON logger. Never pass secrets or document contents in `data`. */
function log(level: Level, msg: string, data?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, d?: Record<string, unknown>) => log("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => log("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => log("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => log("error", m, d),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
