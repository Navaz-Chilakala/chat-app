import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export class UnsafeUrlError extends Error {}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let addr = ipaddr.parse(address);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  // Only globally-routable unicast. This excludes private, loopback, link-local (incl. 169.254.169.254
  // cloud metadata), CGNAT, unique-local, multicast, reserved and unspecified ranges.
  return addr.range() === "unicast";
}

export interface UrlPolicy {
  allowedHosts?: string[]; // exact hostnames or ".suffix" entries; empty = any public host
  allowedPorts?: number[];
}

export function validateUrlShape(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new UnsafeUrlError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with embedded credentials are not allowed");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new UnsafeUrlError("Host is not allowed");
  }
  if (ipaddr.isValid(host) && !isPublicAddress(host)) throw new UnsafeUrlError("Private or reserved IP addresses are not allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!(policy.allowedPorts ?? [80, 443]).includes(port)) throw new UnsafeUrlError(`Port ${port} is not allowed`);
  const allow = (policy.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.some((a) => (a.startsWith(".") ? host.endsWith(a) || host === a.slice(1) : host === a))) {
    throw new UnsafeUrlError(`Host ${host} is not on the ingestion allowlist`);
  }
  return url;
}

async function assertResolvesPublic(hostname: string) {
  if (ipaddr.isValid(hostname)) return;
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) throw new UnsafeUrlError("Host did not resolve");
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new UnsafeUrlError("Host resolves to a private or reserved address");
}

let pinnedAgent: Agent | null = null;
let proxyAgent: ProxyAgent | null = null;

/** Dispatcher that re-validates the resolved IP at connect time (defeats DNS rebinding). */
function dispatcher(): Dispatcher {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    // Behind an egress proxy the proxy performs resolution; we still validate DNS beforehand.
    proxyAgent ??= new ProxyAgent({ uri: proxy });
    return proxyAgent;
  }
  pinnedAgent ??= new Agent({
    connect: {
      lookup(hostname, options, cb) {
        dns
          .lookup(hostname, { all: true, verbatim: true })
          .then((addrs) => {
            const ok = addrs.filter((a) => isPublicAddress(a.address));
            if (!ok.length || ok.length !== addrs.length) return cb(new UnsafeUrlError("Host resolves to a private or reserved address"), "", 4);
            const first = ok[0]!;
            if ((options as { all?: boolean }).all) (cb as unknown as (e: Error | null, a: typeof ok) => void)(null, ok);
            else cb(null, first.address, first.family);
          })
          .catch((e: Error) => cb(e, "", 4));
      },
    },
  });
  return pinnedAgent;
}

export interface SafeFetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  body: Buffer;
  headers: Record<string, string>;
}

export interface SafeFetchOptions extends UrlPolicy {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  accept?: string;
}

export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  let current = validateUrlShape(raw, opts);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    await assertResolvesPublic(current.hostname.replace(/^\[|\]$/g, ""));
    const res = await undiciFetch(current, {
      redirect: "manual",
      dispatcher: dispatcher(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      headers: {
        "user-agent": opts.userAgent ?? "TelecomKnowledgeAI/0.1 (+document ingestion; respects robots.txt)",
        accept: opts.accept ?? "*/*",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new UnsafeUrlError("Redirect without Location header");
      current = validateUrlShape(new URL(loc, current).toString(), opts);
      continue;
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > opts.maxBytes) {
      await res.body?.cancel();
      throw new UnsafeUrlError(`Response too large (${declared} bytes > ${opts.maxBytes})`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > opts.maxBytes) throw new UnsafeUrlError(`Response exceeded ${opts.maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { url: current.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks), headers };
  }
  throw new UnsafeUrlError("Too many redirects");
}
