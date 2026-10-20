/**
 * Telecom identifier extraction. Identifiers are normalised to `<kind>:<value>` strings and stored
 * on every chunk (GIN-indexed) so exact technical tokens are matched exactly, never only by embedding
 * similarity. The same function runs over queries, so normalisation is symmetric.
 */

export const NETWORK_FUNCTIONS = [
  "AMF", "SMF", "UPF", "AUSF", "UDM", "UDR", "UDSF", "PCF", "NRF", "NSSF", "NSSAAF", "NEF", "NWDAF", "SEPP", "SCP",
  "CHF", "BSF", "AF", "LMF", "GMLC", "N3IWF", "TNGF", "TWIF", "W-AGF", "SMSF", "UCMF", "EASDF", "NSACF", "5G-EIR", "SIDF",
  "ARPF", "SEAF", "MME", "SGW", "S-GW", "PGW", "P-GW", "HSS", "PCRF", "SGSN", "GGSN", "ePDG", "eNB", "gNB", "ng-eNB",
  "UE", "P-CSCF", "S-CSCF", "I-CSCF", "IMS-AGW", "MSC", "HLR", "TWAN", "SMS-SC", "PCEF", "TDF", "OCS", "OFCS",
] as const;

const NF_SET = new Set(NETWORK_FUNCTIONS.map((n) => n.toUpperCase()));

// Reference points / interfaces (5GS N-interfaces, EPC S/X interfaces, Diameter G/R/S interfaces, radio).
const INTERFACE_RE =
  /\b(N(?:[1-9]|[1-6]\d|7[0-9])(?:mb|mc)?|S1-MME|S1-U|S1-AP|S(?:2a|2b|3|4|5|6a|6d|8|9|10|11|12|13)|SGi|SGs|X2(?:-C|-U)?|Xn(?:-C|-U)?|F1(?:-C|-U)?|E1|Uu|Gx|Gy|Gz|Rx|Sd|Sy|Cx|Dx|Sh|Mw|Gm|Mb|Nnef|Nchf)\b/g;

const SPEC_RE = /\b(?:3GPP\s+)?(TS|TR)\s*(\d{2})\.(\d{3})(?:-(\d+))?\b/gi;
const BARE_SPEC_RE = /\b(\d{2})\.(\d{3})(?:-(\d+))?\b/g; // only used when the text is query-like
const CLAUSE_CTX_RE = /\b(?:clause|subclause|section|§)\s*((?:[A-Z]\.)?\d+(?:\.\d+){0,8})\b/gi;
const NAS_TIMER_RE = /\bT3[0-9]{3}\b/g;
const RRC_TIMER_RE = /\bT3[0-9]{2}\b/g;
const SBI_OP_RE = /\bN(?:amf|smf|udm|udr|ausf|pcf|nrf|nssf|nef|nwdaf|chf|bsf|smsf|lmf|scp|sepp|nssaaf|udsf|5g-eir|af|gmlc|nsacf|ucmf|easdf|upf|tsctsf|mbsmf|mbsf|dccf|adrf|mfaf|nwdaf)_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)?\b/g;
const CAMEL_RE = /\b[A-Z][a-z0-9]+(?:[A-Z]+[a-z0-9]*){2,}\b|\b[A-Z]{2,}[a-z]+(?:[A-Z][a-z0-9]+)+\b/g;
// Two-hump names count as messages only when they end in a message word (RegistrationRequest, ServiceAccept).
const MSG_WORDS = "Request|Response|Accept|Reject|Complete|Command|Message|Indication|Failure|Notification|Acknowledge|Ack|Answer|Transfer|Setup|Release|Update|Modification|Report|Confirm";
const CAMEL2_RE = new RegExp(`\\b[A-Z][a-z0-9]+(?:${MSG_WORDS})\\b`, "g");
// NAS / RRC state names (5GMM-REGISTERED.ATTEMPTING-REGISTRATION-UPDATE, EMM-DEREGISTERED, RRC_CONNECTED).
const STATE_RE = /\b(?:5GMM|5GSM|EMM|ESM|GMM|MM)-[A-Z][A-Z-]*(?:\.[A-Z][A-Z-]*[A-Z])?\b|\bRRC_(?:IDLE|INACTIVE|CONNECTED)\b/g;
const HYPHEN_IE_RE = /\b[A-Z][A-Za-z0-9]*(?:-[A-Z0-9][A-Za-z0-9]*){2,}\b/g;
const MSG_SUFFIX = "MESSAGE|REQUEST|RESPONSE|ACCEPT|REJECT|COMPLETE|COMMAND|FAILURE|INDICATION|ACKNOWLEDGE|NOTIFICATION|TRANSFER|TRANSPORT|SETUP|RELEASE|MODIFICATION|UPDATE|CONFIRM";
const UPPER_MSG_RE = new RegExp(`\\b(?:[A-Z0-9][A-Z0-9-]{1,}\\s+){1,6}(?:${MSG_SUFFIX})\\b`, "g");
const RELEASE_RE = /\b(?:Rel(?:ease)?[-\s.]?)(\d{1,2})\b/gi;
const CAUSE_RE = /\b(5GMM|5GSM|EMM|ESM)\s+cause\s*(?:value\s*)?#?\s*(\d{1,3})\b/gi;

const COMMON_UPPER_WORDS = new Set([
  "THE", "AND", "FOR", "NOT", "SHALL", "WITH", "FROM", "THIS", "THAT", "NOTE", "IF", "OR", "TO", "OF", "IN", "IS", "BE",
  "A", "AN", "ON", "BY", "AS", "AT", "IT", "NO", "ANY", "ALL",
]);

export function normaliseMessageName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export interface ExtractOptions {
  /** Treat bare `23.502`-style numbers as spec references (true for queries, false for body text). */
  bareSpecNumbers?: boolean;
}

export function extractIdentifiers(text: string, opts: ExtractOptions = {}): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = `${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}`;
    out.add(`spec:${spec}`);
  }
  if (opts.bareSpecNumbers) {
    for (const m of text.matchAll(BARE_SPEC_RE)) {
      const series = Number(m[1]);
      if (series >= 21 && series <= 55) out.add(`spec:${m[1]}.${m[2]}${m[3] ? `-${m[3]}` : ""}`);
    }
  }
  for (const m of text.matchAll(CLAUSE_CTX_RE)) out.add(`clause:${m[1]}`);
  for (const m of text.matchAll(NAS_TIMER_RE)) out.add(`timer:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(RRC_TIMER_RE)) out.add(`timer:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(SBI_OP_RE)) out.add(`svc:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(INTERFACE_RE)) out.add(`if:${m[0].toLowerCase()}`);
  for (const m of text.matchAll(CAUSE_RE)) out.add(`cause:${m[1]!.toLowerCase()}#${Number(m[2])}`);
  for (const m of text.matchAll(CAMEL_RE)) {
    if (m[0].length >= 6) out.add(`msg:${normaliseMessageName(m[0])}`);
  }
  for (const m of text.matchAll(CAMEL2_RE)) out.add(`msg:${normaliseMessageName(m[0])}`);
  if (opts.bareSpecNumbers) for (const id of queryPhraseIdentifiers(text)) out.add(id);
  const stateSpans: [number, number][] = [];
  for (const m of text.matchAll(STATE_RE)) {
    out.add(`state:${m[0].toLowerCase()}`);
    stateSpans.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(HYPHEN_IE_RE)) {
    // Parts of a state name (the ATTEMPTING-REGISTRATION-UPDATE in 5GMM-REGISTERED.ATTEMPTING-...) are not IEs.
    if (stateSpans.some(([s, e]) => m.index! >= s && m.index! < e)) continue;
    out.add(`ie:${m[0].toLowerCase()}`);
  }
  for (const m of text.matchAll(UPPER_MSG_RE)) {
    const words = m[0].trim().split(/\s+/).filter((w) => !COMMON_UPPER_WORDS.has(w));
    if (words.length >= 2) out.add(`msg:${normaliseMessageName(words.join(""))}`);
  }
  // Network functions: exact upper-case tokens only, to avoid matching ordinary words.
  for (const tok of text.match(/\b[A-Za-z0-9-]{2,8}\b/g) ?? []) {
    const up = tok.toUpperCase();
    if (NF_SET.has(up) && (tok === tok.toUpperCase() || /^(eNB|gNB|ng-eNB|ePDG)$/.test(tok))) out.add(`nf:${up.replace(/-/g, "")}`);
  }
  return [...out];
}

const PHRASE_END = new RegExp(`^(${MSG_WORDS.toLowerCase()}|ack)$`);
const PHRASE_STOP = new Set(["the", "a", "an", "of", "to", "for", "in", "on", "and", "or", "is", "what", "which", "how", "does", "do", "find", "where", "when", "why", "send", "sends", "sent", "handle", "handles", "about", "explain", "with"]);

/**
 * Query-only: candidate message identifiers from natural-language phrases ("initial UE message",
 * "PDU session establishment request") so the exact-identifier channel matches CamelCase/UPPER forms in
 * documents and code. Only phrases ending in a message word are considered.
 */
export function queryPhraseIdentifiers(text: string): string[] {
  const words = text.split(/[^A-Za-z0-9-]+/).filter(Boolean);
  const out = new Set<string>();
  for (let end = 0; end < words.length; end++) {
    if (!PHRASE_END.test(words[end]!.toLowerCase())) continue;
    for (let len = 2; len <= 6 && end - len + 1 >= 0; len++) {
      const span = words.slice(end - len + 1, end + 1);
      if (PHRASE_STOP.has(span[0]!.toLowerCase())) break;
      if (span.some((w) => PHRASE_STOP.has(w.toLowerCase()))) break;
      out.add(`msg:${normaliseMessageName(span.join(""))}`);
    }
  }
  return [...out];
}

export function extractReleases(text: string): number[] {
  const rels = new Set<number>();
  for (const m of text.matchAll(RELEASE_RE)) {
    const r = Number(m[1]);
    if (r >= 4 && r <= 25) rels.add(r);
  }
  return [...rels];
}

/** Clause references that appear without a "clause" keyword, e.g. "Explain 6.1.3 of TS 23.502". */
export function extractLooseClauses(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{1,2}(?:\.\d{1,3}){1,8})\b/g)) {
    const v = m[1]!;
    // Skip things that are clearly spec numbers (NN.NNN) or versions (x.y.z handled by caller).
    if (/^\d{2}\.\d{3}$/.test(v)) continue;
    out.add(v);
  }
  return [...out];
}

const NORMATIVE_RE = /\b(shall(?:\s+not)?|must(?:\s+not)?|is required to|should(?:\s+not)?)\b/i;
export function isNormativeSentence(s: string): boolean {
  return NORMATIVE_RE.test(s);
}

const INJECTION_RE =
  /\b(ignore (?:all |any )?(?:previous|prior|above) instructions|disregard (?:the )?(?:system|previous) (?:prompt|instructions)|you are now (?:an?|the) |system prompt:|<\/?(?:system|assistant)>|reveal (?:your|the) (?:system )?prompt)\b/i;
export function looksLikePromptInjection(s: string): boolean {
  return INJECTION_RE.test(s);
}
