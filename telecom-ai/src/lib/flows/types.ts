export interface FlowStep {
  label: string; // step number as written in the source, or ordinal for curated flows
  from: string;
  to: string;
  message: string;
  interface?: string;
  protocol?: string;
  optional?: boolean;
  condition?: string;
  /** Verification against indexed evidence. */
  status?: "from_source_text" | "found_in_clause" | "not_found_in_clause" | "spec_not_indexed";
  citation?: number | null; // evidence number when derived from / verified against a chunk
  sourceText?: string;
}

export interface FlowResult {
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
