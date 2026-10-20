import { extractIdentifiers, extractLooseClauses, extractReleases, looksLikePromptInjection } from "../telecom/identifiers";
import { tokenize } from "../embeddings/local-hash";

export type Intent = "definition" | "compare" | "procedure" | "failure" | "code" | "api" | "release_diff" | "requirement" | "general";

export interface QueryAnalysis {
  original: string;
  normalized: string;
  identifiers: string[];
  strongIdentifiers: string[]; // identifiers specific enough for exact-match retrieval
  specNumbers: string[];
  clauses: string[];
  releases: number[];
  versions: string[];
  intents: Intent[];
  generation: "lte" | "5g" | "both" | null;
  keywords: string[];
  compareParts: string[] | null;
  definitionTerm: string | null;
  injectionLike: boolean;
}

const QUESTION_WORDS = new Set("what which who whom whose why how explain describe tell show give list find please me about between difference compare versus vs is are was the a an of in on for to and or do does did can could would should".split(" "));

export function analyzeQuery(q: string): QueryAnalysis {
  const normalized = q.replace(/\s+/g, " ").trim();
  const identifiers = extractIdentifiers(normalized, { bareSpecNumbers: true });
  const specNumbers = identifiers.filter((i) => i.startsWith("spec:")).map((i) => i.slice(5));
  const versions = [...normalized.matchAll(/\bV(\d+\.\d+\.\d+)\b/gi)].map((m) => m[1]!);
  const explicitClauses = identifiers.filter((i) => i.startsWith("clause:")).map((i) => i.slice(7));
  // "6.1.3 of TS 23.502": loose clause numbers count only when a spec is named and they are not versions.
  const loose = specNumbers.length
    ? extractLooseClauses(normalized.replace(/\bV\d+\.\d+\.\d+\b/gi, " ").replace(/\b(?:TS|TR)\s*\d{2}\.\d{3}(?:-\d+)?\b/gi, " ")).filter(
        (c) => !specNumbers.includes(c) && !versions.includes(c),
      )
    : [];
  const clauses = [...new Set([...explicitClauses, ...loose])];
  const lower = normalized.toLowerCase();
  const intents: Intent[] = [];
  if (/^(what|who)\s+(is|are)\b(?!.*\b(difference|procedure|flow|steps?)\b)|^what does \S+(\s+\S+)? (mean|stand for)\b|\bdefin(e|ition)|\bmeaning of\b|\bstands? for\b|\brole of\b/.test(lower)) intents.push("definition");
  if (/\bdifferen(ce|t)\b|\bcompare|\bcomparison\b|\bversus\b|\bvs\.?\b|\bdiffer\b/.test(lower)) intents.push("compare");
  if (/\bprocedure|\bflow\b|\btrace\b|\bsequence\b|\bsteps?\b|\bcall flow|\bhow (is|are|does|do)\b.*\b(establish|set up|setup|work|performed|happen|register)|\bsignall?ing\b/.test(lower)) intents.push("procedure");
  if (/\bfail|\breject|\babnormal|\berror|\bcause\b|\btimeout|\bexpir|\brecovery/.test(lower)) intents.push("failure");
  if (/\bwhere (is|are|does|do)\b.*\b(handle[sd]?|implement(ed|s)?|process(es|ed)?|decode[sd]?|encode[sd]?|sen[dt]s?|parse[sd]?|receive[sd]?)\b|\bimplement|\bsource code|\bcode\b|\bfunction\b|\bhandler|\brepositor|\bwhere is .* (handled|implemented|decoded|encoded)|\bopen5gs|\bfree5gc|\bueransim|\bsrsran|\bopenairinterface|\boai\b/.test(lower)) intents.push("code");
  if (/\bendpoint|\boperation(id)?\b|\bapi\b|\bopenapi|\bschema\b|\b(get|post|put|patch|delete)\s+\/|\bresponse code|\bhttp\s*\d{3}|\bsbi\b|\bn[a-z]{2,5}_[a-z]+/i.test(normalized)) intents.push("api");
  if (/\bchanged? between|\bdifference between (rel|release)|\brel(ease)?[-\s]?\d+\s+(vs|and|versus)\s+rel/i.test(normalized)) intents.push("release_diff");
  if (/\bshall\b|\bmandatory\b|\brequirement|\bnormative|\bmust\b/.test(lower)) intents.push("requirement");
  if (!intents.length) intents.push("general");

  const lteHint = /\b(lte|epc|eps|e-utra\w*|enb|mme|s-?gw|p-?gw|hss|pcrf|attach|s1ap|s1-mme|x2|gtpv2|diameter|s6a|s11)\b/i.test(normalized);
  const fiveHint = /\b(5g\w*|nr|gnb|amf|smf|upf|ausf|udm|nrf|pcf|nssf|ngap|n[1-9]|pdu session|registration|sbi|nas-5gs|5gmm|5gsm|xn)\b/i.test(normalized);
  const generation = lteHint && fiveHint ? "both" : lteHint ? "lte" : fiveHint ? "5g" : null;

  const keywords = [...new Set(tokenize(normalized).filter((t) => !QUESTION_WORDS.has(t) && t.length > 1 && !/^\d+$/.test(t)))];

  let compareParts: string[] | null = null;
  const cm =
    /difference between (.+?) and (.+?)[?.!]*$/i.exec(normalized) ??
    /compare (.+?) (?:with|and|to|vs\.?|versus) (.+?)[?.!]*$/i.exec(normalized) ??
    /^(.+?) (?:vs\.?|versus) (.+?)[?.!]*$/i.exec(normalized);
  if (cm) compareParts = [cm[1]!.trim(), cm[2]!.trim()];

  let definitionTerm: string | null = null;
  const dm = /^(?:what (?:is|are|does)|define|meaning of|role of)\s+(?:an?\s+|the\s+)?(.+?)(?:\s+(?:mean|stand for|do))?[?.!]*$/i.exec(normalized) ?? /\brole of (?:an?\s+|the\s+)?(.+?)[?.!]*$/i.exec(normalized);
  if (dm) definitionTerm = dm[1]!.trim();

  const strongIdentifiers = identifiers.filter((i) => !/^(spec|clause|nf):/.test(i));
  return {
    original: q,
    normalized,
    identifiers,
    strongIdentifiers,
    specNumbers,
    clauses,
    releases: extractReleases(normalized),
    versions,
    intents,
    generation,
    keywords,
    compareParts,
    definitionTerm,
    injectionLike: looksLikePromptInjection(normalized),
  };
}
