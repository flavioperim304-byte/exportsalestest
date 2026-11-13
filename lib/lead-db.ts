import { Pool, type PoolClient } from "pg"
import { newSignalEvents } from "./signals/events"
import { databaseHintFromUrl, explainPostgresError } from "./database-url"
import { stampIntelligence } from "./intelligence"
import { envDatabaseUrl, getDatabaseUrl } from "./keys"
import { SAMPLE_RUN_ID } from "./ids"
import {
  DESK_COMPANIES_TABLE,
  DESK_LEAD_EVENTS_TABLE,
  DESK_LEAD_VERSIONS_TABLE,
  DESK_RUN_VERSIONS_TABLE,
  auditChanged,
  companyIdFor,
  leadAudit,
  leadBestFit,
  memoryEvents,
  snapshotReason,
  type ScanSource,
} from "./memory"
import type { DbStatus, Lead, LeadMemoryEvent, LeadRecord, LeadSeed, Run } from "./types"

/** Live Export Desk tables. Older CRM tables in the same project are never read. */
export const DESK_RUNS_TABLE = "desk_runs"
export const DESK_LEADS_TABLE = "desk_leads"
export {
  DESK_COMPANIES_TABLE,
  DESK_LEAD_EVENTS_TABLE,
  DESK_LEAD_VERSIONS_TABLE,
  DESK_RUN_VERSIONS_TABLE,
} from "./memory"

export const IGNORED_SUPABASE_TABLES = [
  "Leads",
  "leads_master",
  "leads_enriquecidas",
  "leads_comesa_gem",
  "leads-lote13",
  "tradeindata_novas_leads_import",
  "tradeindata_stage_20260810",
  "trade_test_runs",
  "trade_test_shipments",
  "trade_test_companies",
  "clientes",
  "demandas_clientes",
  "distribuidores_cadastrados",
  "evidencias_empresas",
  "fornecedores_feira",
  "fornecedores_nacionais",
  "fornecedores_nacionais_icp",
  "importadores_premium",
  "matches_feira",
  "matches_inteligentes",
  "mensagens_abordagem",
  "oportunidades_comerciais",
  "relacoes_embarque",
  "swift_search_jobs",
] as const

const SCHEMA = `
CREATE TABLE IF NOT EXISTS desk_runs (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  supplier TEXT NOT NULL,
  markets TEXT NOT NULL,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS desk_leads (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES desk_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  url TEXT NOT NULL,
  country TEXT NOT NULL,
  market TEXT,
  seed TEXT,
  band TEXT,
  score INTEGER,
  fit TEXT,
  fit_index INTEGER,
  icp TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  last_purchase TEXT,
  response_level TEXT,
  response_score INTEGER,
  response_note TEXT,
  signals_at TIMESTAMPTZ,
  hiring BOOLEAN,
  mix_change BOOLEAN,
  social_growth BOOLEAN,
  rag_match BOOLEAN,
  rag_neighbor TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX IF NOT EXISTS desk_leads_domain_idx ON desk_leads (lower(domain));
CREATE INDEX IF NOT EXISTS desk_leads_country_idx ON desk_leads (country);
CREATE INDEX IF NOT EXISTS desk_leads_name_idx ON desk_leads (lower(name));
CREATE INDEX IF NOT EXISTS desk_leads_response_idx ON desk_leads (response_level, response_score DESC);
CREATE INDEX IF NOT EXISTS desk_leads_signals_idx ON desk_leads (signals_at);
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS response_level TEXT;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS response_score INTEGER;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS response_note TEXT;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS signals_at TIMESTAMPTZ;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS hiring BOOLEAN;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS mix_change BOOLEAN;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS social_growth BOOLEAN;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS fit_index INTEGER;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS icp TEXT;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS rag_match BOOLEAN;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS rag_neighbor TEXT;
ALTER TABLE desk_runs ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;
ALTER TABLE desk_leads ADD COLUMN IF NOT EXISTS last_scan_source TEXT;
CREATE TABLE IF NOT EXISTS desk_companies (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  last_scan_at TIMESTAMPTZ,
  last_scan_source TEXT,
  last_icp TEXT,
  last_best_fit TEXT,
  last_fit TEXT,
  last_response_level TEXT,
  last_response_score INTEGER,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS desk_run_versions (
  run_id TEXT NOT NULL REFERENCES desk_runs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, version)
);
CREATE TABLE IF NOT EXISTS desk_lead_versions (
  run_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  company_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (run_id, lead_id, version)
);
CREATE TABLE IF NOT EXISTS desk_lead_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  run_id TEXT,
  lead_id TEXT,
  at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB
);
CREATE INDEX IF NOT EXISTS desk_companies_domain_idx ON desk_companies (lower(domain));
CREATE INDEX IF NOT EXISTS desk_lead_events_company_idx ON desk_lead_events (company_id, at DESC);
CREATE INDEX IF NOT EXISTS desk_lead_versions_company_idx ON desk_lead_versions (company_id, at DESC);
CREATE INDEX IF NOT EXISTS desk_leads_company_idx ON desk_leads (company_id);
ALTER TABLE desk_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_run_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_lead_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_lead_events ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE desk_runs FROM anon;
    REVOKE ALL ON TABLE desk_leads FROM anon;
    REVOKE ALL ON TABLE desk_companies FROM anon;
    REVOKE ALL ON TABLE desk_run_versions FROM anon;
    REVOKE ALL ON TABLE desk_lead_versions FROM anon;
    REVOKE ALL ON TABLE desk_lead_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE desk_runs FROM authenticated;
    REVOKE ALL ON TABLE desk_leads FROM authenticated;
    REVOKE ALL ON TABLE desk_companies FROM authenticated;
    REVOKE ALL ON TABLE desk_run_versions FROM authenticated;
    REVOKE ALL ON TABLE desk_lead_versions FROM authenticated;
    REVOKE ALL ON TABLE desk_lead_events FROM authenticated;
  END IF;
END $$;
`

let pool: Pool | undefined
let schemaReady: Promise<void> | undefined
let migrated = false
let lastError: string | undefined

let poolUrl = ""

export function databaseUrl(): string {
  return getDatabaseUrl()
}

export function resetPostgresPool() {
  const old = pool
  pool = undefined
  poolUrl = ""
  schemaReady = undefined
  migrated = false
  lastError = undefined
  void old?.end().catch(() => undefined)
}

export function postgresConfigured(): boolean {
  return Boolean(databaseUrl()) && process.env.NEXT_PHASE !== "phase-production-build"
}

export function postgresLastError(): string | undefined {
  return lastError
}

export function postgresWantsSsl(url: string): boolean {
  if (process.env.DATABASE_SSL === "false") return false
  if (process.env.DATABASE_SSL === "true" || process.env.PGSSLMODE === "require") return true
  if (/sslmode=require/i.test(url)) return true
  if (/sslmode=(disable|allow|prefer)/i.test(url)) return false
  return /\.render\.com|\.supabase\.co|\.supabase\.com/i.test(url)
}

function getPool(): Pool {
  const url = databaseUrl()
  if (!url) throw new Error("DATABASE_URL is not set.")
  if (!pool || poolUrl !== url) {
    const old = pool
    pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 12_000,
      ssl: postgresWantsSsl(url) ? { rejectUnauthorized: false } : undefined,
    })
    poolUrl = url
    schemaReady = undefined
    migrated = false
    void old?.end().catch(() => undefined)
  }
  return pool
}

export function toLeadRecord(run: Run, lead: Lead): LeadRecord {
  return {
    id: lead.id,
    runId: run.id,
    name: lead.name,
    domain: lead.domain || "",
    url: lead.url || "",
    country: lead.country || lead.market || "",
    market: lead.market,
    seed: lead.seed,
    supplier: run.brief.supplierName,
    status: run.status,
    band: lead.score?.band,
    score: lead.score?.total,
    fit: lead.fit?.level,
    fitIndex: lead.fit?.index,
    icp: lead.context?.icp || lead.openai?.icp,
    email: lead.extraction?.email || undefined,
    phone: lead.extraction?.phone || lead.extraction?.whatsapp || undefined,
    website: lead.extraction?.website || lead.url || undefined,
    lastPurchase: lead.extraction?.lastPurchase || undefined,
    responseLevel: lead.response?.level,
    responseScore: lead.response?.score,
    responseNote: lead.response?.note,
    signalsAt: lead.signalsAt || lead.response?.computedAt,
    hiring: lead.response?.hiring,
    mixChange: lead.response?.mixChange,
    socialGrowth: lead.response?.socialGrowth,
    ragMatch: lead.rag?.checked ? lead.rag.match : undefined,
    ragNeighbor: lead.rag?.neighbor || undefined,
    companyId: companyIdFor(lead),
    version: lead.version,
    lastScanAt: lead.lastScanAt || lead.signalsAt || lead.response?.computedAt,
    lastScanSource: lead.lastScanSource,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }
}

export function listLeadRecordsFromRuns(runs: Run[]): LeadRecord[] {
  const rows: LeadRecord[] = []
  for (const run of runs) {
    if (run.mode === "sample") continue
    for (const lead of run.leads ?? []) {
      if (!lead.response || !lead.fit) stampIntelligence(run, lead)
      rows.push(toLeadRecord(run, lead))
    }
  }
  rows.sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name)
  )
  return rows
}

export async function ensureLeadSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((error) => {
        schemaReady = undefined
        throw error
      })
  }
  await schemaReady
}

function liveRuns(runs: Run[]): Run[] {
  return runs.filter((run) => run.mode !== "sample" && run.id !== SAMPLE_RUN_ID)
}

export async function migrateJsonIfEmpty(runs: Run[]): Promise<number> {
  await ensureLeadSchema()
  const counted = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${DESK_RUNS_TABLE}`)
  if ((counted.rows[0]?.n ?? 0) > 0) return 0
  const incoming = liveRuns(runs)
  for (const run of incoming) {
    await pgSaveRun(run)
  }
  return incoming.length
}

export async function readyPostgres(jsonRuns: () => Run[]): Promise<boolean> {
  if (!postgresConfigured()) return false
  try {
    await ensureLeadSchema()
    if (!migrated) {
      await migrateJsonIfEmpty(jsonRuns())
      migrated = true
    }
    lastError = undefined
    return true
  } catch (error) {
    lastError = explainPostgresError(error instanceof Error ? error.message : "Postgres connection failed.")
    return false
  }
}

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    try {
      await client.query("ROLLBACK")
    } catch {
      // Connection already gone.
    }
    throw error
  } finally {
    client.release()
  }
}

/** Fill missing arrays so the Painel never calls .filter on undefined. Empty, not invented. */
export function normalizeRun(run: Run): Run {
  return {
    ...run,
    logs: run.logs ?? [],
    competitors: run.competitors ?? [],
    leads: (run.leads ?? []).map(normalizeLead),
  }
}

function normalizeLead(lead: Lead): Lead {
  const next: Lead = { ...lead }
  if (next.exa) next.exa = { ...next.exa, highlights: next.exa.highlights ?? [] }
  if (next.score) next.score = { ...next.score, dimensions: next.score.dimensions ?? [] }
  if (next.alsoScore) next.alsoScore = { ...next.alsoScore, dimensions: next.alsoScore.dimensions ?? [] }
  if (next.openai) next.openai = { ...next.openai, supplierFits: next.openai.supplierFits ?? [] }
  if (next.fit) next.fit = { ...next.fit, facts: next.fit.facts ?? [], missing: next.fit.missing ?? [] }
  if (next.activity) next.activity = { ...next.activity, signals: next.activity.signals ?? [] }
  if (next.commerce) next.commerce = { ...next.commerce, signals: next.commerce.signals ?? [] }
  return next
}

export async function pgListRuns(): Promise<Run[]> {
  await ensureLeadSchema()
  const { rows } = await getPool().query<{ payload: Run }>(
    `SELECT payload FROM ${DESK_RUNS_TABLE} WHERE id <> $1 ORDER BY created_at DESC`,
    [SAMPLE_RUN_ID]
  )
  return rows.map((row) => normalizeRun(row.payload))
}

export async function pgGetRun(id: string): Promise<Run | null> {
  await ensureLeadSchema()
  const { rows } = await getPool().query<{ payload: Run }>(
    `SELECT payload FROM ${DESK_RUNS_TABLE} WHERE id = $1`,
    [id]
  )
  return rows[0] ? normalizeRun(rows[0].payload) : null
}

function asLeadPayload(value: unknown): Lead | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Lead
  return row.id && row.name ? row : undefined
}

function scanSourceOf(lead: Lead): ScanSource {
  return lead.lastScanSource === "monitor" || lead.lastScanSource === "refresh" ? lead.lastScanSource : "run"
}

async function upsertCompany(
  client: PoolClient,
  lead: Lead,
  scanAt: string | undefined,
  source: ScanSource | null
): Promise<string> {
  const id = companyIdFor(lead)
  const audit = leadAudit(lead)
  await client.query(
    `INSERT INTO ${DESK_COMPANIES_TABLE} (
       id, domain, country, name, url, last_scan_at, last_scan_source,
       last_icp, last_best_fit, last_fit, last_response_level, last_response_score, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       domain = EXCLUDED.domain,
       country = EXCLUDED.country,
       name = EXCLUDED.name,
       url = EXCLUDED.url,
       last_scan_at = COALESCE(EXCLUDED.last_scan_at, ${DESK_COMPANIES_TABLE}.last_scan_at),
       last_scan_source = COALESCE(EXCLUDED.last_scan_source, ${DESK_COMPANIES_TABLE}.last_scan_source),
       last_icp = EXCLUDED.last_icp,
       last_best_fit = EXCLUDED.last_best_fit,
       last_fit = EXCLUDED.last_fit,
       last_response_level = EXCLUDED.last_response_level,
       last_response_score = EXCLUDED.last_response_score,
       updated_at = EXCLUDED.updated_at`,
    [
      id,
      lead.domain || "",
      lead.country || lead.market || "",
      lead.name,
      lead.url || "",
      scanAt ?? null,
      source,
      audit.icp || null,
      leadBestFit(lead) || null,
      audit.fit || null,
      audit.responseLevel || null,
      audit.responseScore === "" ? null : audit.responseScore,
      new Date().toISOString(),
    ]
  )
  return id
}

export async function pgSaveRun(run: Run): Promise<void> {
  if (run.id === SAMPLE_RUN_ID || run.mode === "sample") return
  run = normalizeRun(run)
  await ensureLeadSchema()
  await withTx(async (client) => {
    const previousRun = await client.query<{ status: string; version: number }>(
      `SELECT status, version FROM ${DESK_RUNS_TABLE} WHERE id = $1`,
      [run.id]
    )
    const previousLeads = await client.query<{ id: string; version: number; payload: unknown }>(
      `SELECT id, version, payload FROM ${DESK_LEADS_TABLE} WHERE run_id = $1`,
      [run.id]
    )
    const previousById = new Map(previousLeads.rows.map((row) => [row.id, row]))
    const priorStatus = previousRun.rows[0]?.status
    const runVersion = (previousRun.rows[0]?.version ?? 0) + (priorStatus !== run.status ? 1 : 0)
    const nextRunVersion = Math.max(1, priorStatus === undefined ? 1 : runVersion)

    await client.query(
      `INSERT INTO ${DESK_RUNS_TABLE} (id, created_at, updated_at, mode, status, supplier, markets, payload, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = EXCLUDED.updated_at,
         mode = EXCLUDED.mode,
         status = EXCLUDED.status,
         supplier = EXCLUDED.supplier,
         markets = EXCLUDED.markets,
         payload = EXCLUDED.payload,
         version = EXCLUDED.version`,
      [
        run.id,
        run.createdAt,
        run.updatedAt,
        run.mode,
        run.status,
        run.brief.supplierName,
        run.brief.markets,
        JSON.stringify(run),
        nextRunVersion,
      ]
    )
    if (priorStatus !== run.status) {
      const reason =
        priorStatus === undefined ? "created" : `status ${priorStatus} → ${run.status}`
      await client.query(
        `INSERT INTO ${DESK_RUN_VERSIONS_TABLE} (run_id, version, at, status, reason, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (run_id, version) DO NOTHING`,
        [run.id, nextRunVersion, run.updatedAt, run.status, reason, JSON.stringify(run)]
      )
    }

    const leads = run.leads ?? []
    const ids = leads.map((lead) => lead.id)
    if (ids.length === 0) {
      await client.query(`DELETE FROM ${DESK_LEADS_TABLE} WHERE run_id = $1`, [run.id])
    } else {
      await client.query(`DELETE FROM ${DESK_LEADS_TABLE} WHERE run_id = $1 AND NOT (id = ANY($2::text[]))`, [
        run.id,
        ids,
      ])
    }
    for (const lead of leads) {
      const source = scanSourceOf(lead)
      const scanAt = lead.lastScanAt || lead.signalsAt || (!previousById.get(lead.id) ? run.updatedAt : undefined)
      const companyScan = lead.lastScanSource || (!previousById.get(lead.id) ? "run" : null)
      const companyId = await upsertCompany(client, lead, scanAt, companyScan)
      const previous = previousById.get(lead.id)
      const previousLead = asLeadPayload(previous?.payload)
      const before = previousLead ? leadAudit(previousLead) : undefined
      const after = leadAudit(lead)
      const versioned = auditChanged(before, after)
      const nextVersion = versioned ? (previous?.version ?? 0) + 1 : (previous?.version ?? 1)
      if (versioned) {
        lead.version = nextVersion
        const reason = snapshotReason(before, after, source)
        await client.query(
          `INSERT INTO ${DESK_LEAD_VERSIONS_TABLE} (run_id, lead_id, version, company_id, at, reason, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT (run_id, lead_id, version) DO NOTHING`,
          [run.id, lead.id, nextVersion, companyId, run.updatedAt, reason, JSON.stringify(lead)]
        )
        for (const event of memoryEvents(before, after, source)) {
          await client.query(
            `INSERT INTO ${DESK_LEAD_EVENTS_TABLE} (
               id, company_id, run_id, lead_id, at, source, kind, summary, before_state, after_state
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
            [
              crypto.randomUUID(),
              companyId,
              run.id,
              lead.id,
              run.updatedAt,
              event.source,
              event.kind,
              event.summary,
              event.before ? JSON.stringify(event.before) : null,
              event.after ? JSON.stringify(event.after) : null,
            ]
          )
        }
      } else if (source === "monitor" || source === "refresh") {
        for (const event of memoryEvents(before, after, source)) {
          if (event.kind !== "scan") continue
          await client.query(
            `INSERT INTO ${DESK_LEAD_EVENTS_TABLE} (
               id, company_id, run_id, lead_id, at, source, kind, summary, before_state, after_state
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
            [
              crypto.randomUUID(),
              companyId,
              run.id,
              lead.id,
              scanAt || run.updatedAt,
              event.source,
              event.kind,
              event.summary,
              event.before ? JSON.stringify(event.before) : null,
              event.after ? JSON.stringify(event.after) : null,
            ]
          )
        }
      }
      // Intent-signal events (lib/signals): one row per new event, existing table, no schema change.
      for (const event of newSignalEvents(previousLead, lead)) {
        await client.query(
          `INSERT INTO ${DESK_LEAD_EVENTS_TABLE} (
             id, company_id, run_id, lead_id, at, source, kind, summary, before_state, after_state
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            `${run.id}:${lead.id}:${event.id}`,
            companyId,
            run.id,
            lead.id,
            event.detectedAt,
            event.source,
            `signal:${event.type}`,
            (event.evidence.title || event.subtype).slice(0, 220),
            JSON.stringify(event),
          ]
        )
      }
      const row = toLeadRecord(run, lead)
      await client.query(
        `INSERT INTO ${DESK_LEADS_TABLE} (
           id, run_id, name, domain, url, country, market, seed, band, score, fit, fit_index, icp,
           email, phone, website, last_purchase, response_level, response_score, response_note,
           signals_at, hiring, mix_change, social_growth, rag_match, rag_neighbor, payload, updated_at,
           company_id, version, last_scan_at, last_scan_source
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27::jsonb, $28, $29, $30, $31, $32
         )
         ON CONFLICT (run_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           domain = EXCLUDED.domain,
           url = EXCLUDED.url,
           country = EXCLUDED.country,
           market = EXCLUDED.market,
           seed = EXCLUDED.seed,
           band = EXCLUDED.band,
           score = EXCLUDED.score,
           fit = EXCLUDED.fit,
           fit_index = EXCLUDED.fit_index,
           icp = EXCLUDED.icp,
           email = EXCLUDED.email,
           phone = EXCLUDED.phone,
           website = EXCLUDED.website,
           last_purchase = EXCLUDED.last_purchase,
           response_level = EXCLUDED.response_level,
           response_score = EXCLUDED.response_score,
           response_note = EXCLUDED.response_note,
           signals_at = EXCLUDED.signals_at,
           hiring = EXCLUDED.hiring,
           mix_change = EXCLUDED.mix_change,
           social_growth = EXCLUDED.social_growth,
           rag_match = EXCLUDED.rag_match,
           rag_neighbor = EXCLUDED.rag_neighbor,
           payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at,
           company_id = EXCLUDED.company_id,
           version = EXCLUDED.version,
           last_scan_at = COALESCE(EXCLUDED.last_scan_at, ${DESK_LEADS_TABLE}.last_scan_at),
           last_scan_source = COALESCE(EXCLUDED.last_scan_source, ${DESK_LEADS_TABLE}.last_scan_source)`,
        [
          row.id,
          row.runId,
          row.name,
          row.domain,
          row.url,
          row.country,
          row.market ?? null,
          row.seed ?? null,
          row.band ?? null,
          row.score ?? null,
          row.fit ?? null,
          row.fitIndex ?? null,
          row.icp ?? null,
          row.email ?? null,
          row.phone ?? null,
          row.website ?? null,
          row.lastPurchase ?? null,
          row.responseLevel ?? null,
          row.responseScore ?? null,
          row.responseNote ?? null,
          row.signalsAt ?? null,
          row.hiring ?? null,
          row.mixChange ?? null,
          row.socialGrowth ?? null,
          row.ragMatch ?? null,
          row.ragNeighbor ?? null,
          JSON.stringify(lead),
          row.updatedAt,
          companyId,
          nextVersion,
          lead.lastScanAt ?? scanAt ?? null,
          lead.lastScanSource ?? null,
        ]
      )
    }
  })
}

export async function pgDeleteRun(id: string): Promise<void> {
  await ensureLeadSchema()
  await getPool().query(`DELETE FROM ${DESK_RUNS_TABLE} WHERE id = $1`, [id])
}

type LeadSqlRow = {
  id: string
  run_id: string
  name: string
  domain: string
  url: string
  country: string
  market: string | null
  seed: LeadSeed | null
  band: LeadRecord["band"] | null
  score: number | null
  fit: LeadRecord["fit"] | null
  fit_index: number | null
  icp: LeadRecord["icp"] | null
  email: string | null
  phone: string | null
  website: string | null
  last_purchase: string | null
  response_level: LeadRecord["responseLevel"] | null
  response_score: number | null
  response_note: string | null
  signals_at: Date | string | null
  hiring: boolean | null
  mix_change: boolean | null
  social_growth: boolean | null
  rag_match: boolean | null
  rag_neighbor: string | null
  company_id: string | null
  version: number | null
  last_scan_at: Date | string | null
  last_scan_source: LeadRecord["lastScanSource"] | null
  updated_at: Date | string
  supplier: string
  status: LeadRecord["status"]
  created_at: Date | string
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

export async function pgListLeadRecords(): Promise<LeadRecord[]> {
  await ensureLeadSchema()
  const { rows } = await getPool().query<LeadSqlRow>(
    `SELECT l.id, l.run_id, l.name, l.domain, l.url, l.country, l.market, l.seed,
            l.band, l.score, l.fit, l.fit_index, l.icp, l.email, l.phone, l.website, l.last_purchase,
            l.response_level, l.response_score, l.response_note, l.signals_at,
            l.hiring, l.mix_change, l.social_growth, l.rag_match, l.rag_neighbor,
            l.company_id, l.version, l.last_scan_at, l.last_scan_source,
            l.updated_at, r.supplier, r.status, r.created_at
     FROM ${DESK_LEADS_TABLE} l
     JOIN ${DESK_RUNS_TABLE} r ON r.id = l.run_id
     ORDER BY l.updated_at DESC, l.name ASC`
  )
  return rows.map((row) => ({
    id: row.id,
    runId: row.run_id,
    name: row.name,
    domain: row.domain,
    url: row.url,
    country: row.country,
    market: row.market || undefined,
    seed: row.seed || undefined,
    supplier: row.supplier,
    status: row.status,
    band: row.band || undefined,
    score: row.score ?? undefined,
    fit: row.fit || undefined,
    fitIndex: row.fit_index ?? undefined,
    icp: row.icp || undefined,
    email: row.email || undefined,
    phone: row.phone || undefined,
    website: row.website || undefined,
    lastPurchase: row.last_purchase || undefined,
    responseLevel: row.response_level || undefined,
    responseScore: row.response_score ?? undefined,
    responseNote: row.response_note || undefined,
    signalsAt: row.signals_at ? iso(row.signals_at) : undefined,
    hiring: row.hiring ?? undefined,
    mixChange: row.mix_change ?? undefined,
    socialGrowth: row.social_growth ?? undefined,
    ragMatch: row.rag_match ?? undefined,
    ragNeighbor: row.rag_neighbor || undefined,
    companyId: row.company_id || undefined,
    version: row.version ?? undefined,
    lastScanAt: row.last_scan_at ? iso(row.last_scan_at) : undefined,
    lastScanSource: row.last_scan_source || undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }))
}

export async function pgListLeadEvents(companyId: string, limit = 40): Promise<LeadMemoryEvent[]> {
  if (!companyId.trim()) return []
  await ensureLeadSchema()
  const { rows } = await getPool().query<{
    id: string
    company_id: string
    run_id: string | null
    lead_id: string | null
    at: Date | string
    source: LeadMemoryEvent["source"]
    kind: string
    summary: string
    before_state: Record<string, unknown> | null
    after_state: Record<string, unknown> | null
  }>(
    `SELECT id, company_id, run_id, lead_id, at, source, kind, summary, before_state, after_state
     FROM ${DESK_LEAD_EVENTS_TABLE}
     WHERE company_id = $1
     ORDER BY at DESC
     LIMIT $2`,
    [companyId, Math.min(80, Math.max(1, limit))]
  )
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    runId: row.run_id || undefined,
    leadId: row.lead_id || undefined,
    at: iso(row.at),
    source: row.source,
    kind: row.kind,
    summary: row.summary,
    before: row.before_state || undefined,
    after: row.after_state || undefined,
  }))
}

function statusHint(url: string): Pick<DbStatus, "source" | "host" | "port" | "user" | "envLocked"> {
  const source = envDatabaseUrl() ? "env" : url ? "file" : "none"
  return {
    ...databaseHintFromUrl(url, source),
    envLocked: Boolean(envDatabaseUrl()),
  }
}

export async function postgresStatus(): Promise<DbStatus> {
  const url = databaseUrl()
  const hint = statusHint(url)
  const tables = [
    DESK_RUNS_TABLE,
    DESK_LEADS_TABLE,
    DESK_COMPANIES_TABLE,
    DESK_RUN_VERSIONS_TABLE,
    DESK_LEAD_VERSIONS_TABLE,
    DESK_LEAD_EVENTS_TABLE,
  ]
  if (!postgresConfigured()) {
    return { postgres: false, leadCount: 0, runCount: 0, source: "none", tables, ...hint }
  }
  try {
    await ensureLeadSchema()
    const runs = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${DESK_RUNS_TABLE}`)
    const leads = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${DESK_LEADS_TABLE}`)
    lastError = undefined
    return {
      postgres: true,
      runCount: runs.rows[0]?.n ?? 0,
      leadCount: leads.rows[0]?.n ?? 0,
      tables,
      ...hint,
    }
  } catch (error) {
    lastError = explainPostgresError(error instanceof Error ? error.message : "Postgres connection failed.")
    return { postgres: true, leadCount: 0, runCount: 0, error: lastError, tables, ...hint }
  }
}
