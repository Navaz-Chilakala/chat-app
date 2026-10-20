// Client-side mirrors of server response shapes (kept structural to avoid importing server modules).
export interface EvidenceItem {
  n: number;
  chunkId: string;
  documentId: string;
  versionId: string;
  title: string;
  specNumber: string | null;
  specType: string | null;
  version: string | null;
  release: number | null;
  isCurrent: boolean;
  clause: string | null;
  headingPath: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  sourceType: string;
  authorityTier: number;
  sourceUrl: string | null;
  chunkType: string;
  content: string;
  contextBefore: string | null;
  contextAfter: string | null;
  score: number;
  channels: string[];
  flags: string[];
  symbol: string | null;
  language: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  repoPath: string | null;
  commitSha: string | null;
  license: string | null;
}

export interface Statement {
  text: string;
  citations: number[];
  kind: string;
}

export interface FlowStep {
  label: string;
  from: string;
  to: string;
  message: string;
  interface?: string;
  protocol?: string;
  optional?: boolean;
  condition?: string;
  status?: string;
  citation?: number | null;
  sourceText?: string;
}

export interface Flow {
  title: string;
  origin: "evidence" | "curated";
  spec: string | null;
  clause: string | null;
  version: string | null;
  steps: FlowStep[];
  mermaid: string;
  notes: string[];
  verification: { clauseIndexed: boolean; stepsFound: number; stepsTotal: number } | null;
}

export interface AnswerData {
  status: "answered" | "partial" | "insufficient_evidence";
  confidence: "high" | "medium" | "low";
  summary: Statement[];
  sections: { id: string; title: string; statements?: Statement[]; table?: { caption: string | null; markdown: string; citation: number }; items?: { label: string; detail: string; citations: number[] }[] }[];
  compare: { label: string; statements: Statement[] }[] | null;
  flow: Flow | null;
  apiOperations: {
    citation: number;
    apiTitle: string;
    apiVersion: string | null;
    method: string;
    path: string;
    operationId: string | null;
    summary: string | null;
    parameters: { name: string; in: string; required: boolean; type: string }[];
    requestBody: string | null;
    responses: { code: string; description: string }[];
    security: string | null;
    specRefs: string[];
  }[];
  gaps: string[];
  conflicts: string[];
  evidence: EvidenceItem[];
  notice: string;
}
