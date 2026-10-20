export const SOURCE_TYPES = {
  official_normative: { label: "Official normative standard", tier: 1 },
  official_informative: { label: "Official informative report", tier: 1 },
  official_schema: { label: "Official schema / protocol definition", tier: 2 },
  standards_body: { label: "Standards body publication (IETF/ITU/GSMA)", tier: 2 },
  reference_implementation: { label: "Reference implementation", tier: 3 },
  vendor: { label: "Vendor-specific documentation", tier: 3 },
  academic: { label: "Academic research", tier: 4 },
  educational: { label: "Educational article", tier: 4 },
  user_provided: { label: "User-provided material", tier: 4 },
  unverified: { label: "Unverified / pending review", tier: 4 },
} as const;

export type SourceType = keyof typeof SOURCE_TYPES;

export function isSourceType(v: string): v is SourceType {
  return v in SOURCE_TYPES;
}
