import { query, queryOne } from "../db";

export const COMMONS_SLUG = "commons";

/** The shared, read-mostly knowledge collection every user can search. */
export async function ensureCommonsWorkspace(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO workspaces(name, slug, kind) VALUES ('Telecom Commons', $1, 'shared')
     ON CONFLICT (slug) DO UPDATE SET name = workspaces.name RETURNING id`,
    [COMMONS_SLUG],
  );
  return row!.id;
}

export interface SeedSource {
  kind: "3gpp_archive" | "url" | "git_repo";
  name: string;
  url: string;
  authority_tier: 1 | 2 | 3 | 4;
  source_type: string;
  trust_level: "official" | "trusted" | "community" | "unverified";
  access_method: string;
  license: string | null;
  status: "active" | "paused" | "pending_review";
  config: Record<string, unknown>;
  sync_interval_hours: number | null;
}

/**
 * Initial source registry. Official 3GPP archive is Tier 1. Repositories are Tier 3 reference
 * implementations and start paused so an admin explicitly approves each sync (license review).
 */
export const SEED_SOURCES: SeedSource[] = [
  {
    kind: "3gpp_archive",
    name: "3GPP specification archive — latest version per spec (series 21–38)",
    url: "https://www.3gpp.org/ftp/Specs/archive/",
    authority_tier: 1,
    source_type: "official_normative",
    trust_level: "official",
    access_method: "official FTP/HTTPS archive (zip deliverables)",
    license: "3GPP copyright — © ARIB, ATIS, CCSA, ETSI, TSDSI, TTA, TTC; internal reference use, no republication",
    status: "active",
    config: { series: ["21", "22", "23", "24", "25", "26", "27", "28", "29", "31", "32", "33", "34", "35", "36", "37", "38"], mode: "latest_per_spec", concurrency: 2, delayMs: 750 },
    sync_interval_hours: 24 * 7,
  },
  {
    kind: "git_repo",
    name: "3GPP 5G Core OpenAPI definitions (forge.3gpp.org)",
    url: "https://forge.3gpp.org/rep/all/5G_APIs.git",
    authority_tier: 2,
    source_type: "official_schema",
    trust_level: "official",
    access_method: "git clone (shallow)",
    license: "3GPP copyright",
    status: "paused",
    config: { ref: "REL-19", include: ["\\.ya?ml$"], maxFiles: 400 },
    sync_interval_hours: 24 * 7,
  },
  {
    kind: "git_repo",
    name: "3GPP 5G Core OpenAPI definitions — GitHub mirror (jdegre/5GC_APIs; verify against forge.3gpp.org)",
    url: "https://github.com/jdegre/5GC_APIs.git",
    authority_tier: 2,
    source_type: "official_schema",
    trust_level: "community",
    access_method: "git clone (shallow) of a community mirror of the official 3GPP OpenAPI files",
    license: "3GPP copyright (mirrored content)",
    status: "paused",
    config: { ref: "Rel-18", include: ["^TS\\d+.*\\.ya?ml$"], maxFiles: 400 },
    sync_interval_hours: 24 * 7,
  },
  ...(
    [
      ["Open5GS", "https://github.com/open5gs/open5gs.git", "AGPL-3.0", "main"],
      ["free5GC", "https://github.com/free5gc/free5gc.git", "Apache-2.0", "main"],
      ["UERANSIM", "https://github.com/aligungr/UERANSIM.git", "GPL-3.0", "master"],
      ["srsRAN Project", "https://github.com/srsran/srsRAN_Project.git", "AGPL-3.0", "main"],
      ["OpenAirInterface 5G (mirror)", "https://gitlab.eurecom.fr/oai/openairinterface5g.git", "OAI Public License v1.1", "develop"],
    ] as const
  ).map(
    ([name, url, license, ref]): SeedSource => ({
      kind: "git_repo",
      name,
      url,
      authority_tier: 3,
      source_type: "reference_implementation",
      trust_level: "community",
      access_method: "git clone (shallow)",
      license,
      status: "paused",
      config: { ref, maxFiles: 6000, maxFileBytes: 400_000 },
      sync_interval_hours: 24 * 7,
    }),
  ),
];

export async function seedSources(workspaceId: string, createdBy: string | null = null): Promise<number> {
  let n = 0;
  for (const s of SEED_SOURCES) {
    const row = await queryOne(
      `INSERT INTO document_sources(workspace_id, kind, name, url, authority_tier, source_type, trust_level, access_method, license, status, config, sync_interval_hours, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (workspace_id, kind, url) DO NOTHING RETURNING id`,
      [workspaceId, s.kind, s.name, s.url, s.authority_tier, s.source_type, s.trust_level, s.access_method, s.license, s.status, s.config, s.sync_interval_hours, createdBy],
    );
    if (row) n++;
  }
  return n;
}

export async function listSources(workspaceIds: string[]) {
  return query(
    `SELECT s.*, (SELECT count(*) FROM documents d WHERE d.source_id = s.id)::int AS document_count,
            (SELECT row_to_json(r) FROM (SELECT status, started_at, finished_at, stats, error FROM source_sync_runs WHERE source_id = s.id ORDER BY started_at DESC LIMIT 1) r) AS last_run
     FROM document_sources s WHERE s.workspace_id = ANY($1) ORDER BY s.authority_tier, s.name`,
    [workspaceIds],
  );
}
