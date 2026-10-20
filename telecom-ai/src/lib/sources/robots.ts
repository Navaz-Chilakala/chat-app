import { safeFetch } from "../security/ssrf";

const cache = new Map<string, { rules: { allow: boolean; path: string }[]; fetched: number }>();
export const USER_AGENT = "TelecomKnowledgeAI/0.1 (+document ingestion; respects robots.txt)";

/** Minimal robots.txt evaluation for the `*` and our own user-agent groups (longest-match wins). */
export async function robotsAllows(rawUrl: string): Promise<boolean> {
  const url = new URL(rawUrl);
  const key = url.origin;
  let entry = cache.get(key);
  if (!entry || Date.now() - entry.fetched > 3600_000) {
    let text = "";
    try {
      const res = await safeFetch(`${url.origin}/robots.txt`, { maxBytes: 512 * 1024, timeoutMs: 15_000, userAgent: USER_AGENT });
      if (res.status === 200) text = res.body.toString("utf8");
    } catch {
      text = ""; // unreachable robots.txt = no restrictions declared
    }
    entry = { rules: parseRobots(text), fetched: Date.now() };
    cache.set(key, entry);
  }
  const path = url.pathname + url.search;
  let best: { allow: boolean; path: string } | null = null;
  for (const r of entry.rules) if (r.path && path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return best ? best.allow : true;
}

export function parseRobots(text: string): { allow: boolean; path: string }[] {
  const rules: { allow: boolean; path: string }[] = [];
  let applies = false;
  let sawRule = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === "user-agent") {
      if (sawRule) {
        applies = false;
        sawRule = false;
      }
      if (value === "*" || USER_AGENT.toLowerCase().startsWith(value.toLowerCase())) applies = true;
    } else if (field === "allow" || field === "disallow") {
      sawRule = true;
      if (applies) rules.push({ allow: field === "allow", path: value });
    }
  }
  return rules;
}
