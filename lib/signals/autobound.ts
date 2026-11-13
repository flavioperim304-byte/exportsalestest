import type { SignalEvent, SignalScan, SignalType, SignalTypeStatus } from "../types"
import { ApiError } from "../http"
import { asString, clip, domainOf } from "../text"
import { SIGNAL_TYPES, confidenceFor, eventId, normalizeType, validDate } from "./events"

export const AUTOBOUND_BASE = "https://signals.autobound.ai/v1"
export const AUTOBOUND_STAGE_VERSION = "signals-autobound@1.1.0"
/** Signal types the user confirmed in the Autobound dashboard (2026-11-12). */
export const USER_CONFIRMED_SIGNAL_TYPES = ["news", "producthunt-launch", "website-intelligence", "linkedin-post-company"]
/** Documented by Autobound but not yet seen in the user's dashboard: used only when the live type catalog lists them. */
export const CATALOG_ONLY_SIGNAL_TYPES = ["hiring-trends", "hiring-velocity"]
/** Worst case published by Autobound: 2 credits per signal returned. Used for the budget. */
export const CREDITS_PER_SIGNAL_WORST_CASE = 2
export const DEFAULT_SIGNAL_LIMIT = 5
export const DEFAULT_RUN_BUDGET = 50
export const SIGNAL_WINDOW_MONTHS = 24

/** Tracks spend against a hard ceiling. A call is refused when its worst case does not fit. */
export class CreditBudget {
  readonly ceiling: number
  spent = 0

  constructor(ceiling: number, spent = 0) {
    this.ceiling = Math.max(0, ceiling)
    this.spent = Math.max(0, spent)
  }

  get remaining(): number {
    return Math.max(0, this.ceiling - this.spent)
  }

  canAfford(worstCase: number): boolean {
    return worstCase <= this.remaining
  }

  charge(credits: number) {
    this.spent += Math.max(0, credits)
  }

  release(credits: number) {
    this.spent = Math.max(0, this.spent - Math.max(0, credits))
  }
}

export function windowStart(now = new Date(), months = SIGNAL_WINDOW_MONTHS): string {
  const start = new Date(now)
  start.setMonth(start.getMonth() - months)
  return start.toISOString()
}

export type EnrichOptions = {
  key?: string
  budget: CreditBudget
  limit?: number
  /** Provider signal_types filter. Omit to let the provider return any type (still capped by limit). */
  signalTypes?: string[]
  detectedAfter?: string
  dryRun?: boolean
  runId?: string
  now?: Date
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type EnrichResult = { scan: SignalScan; events: SignalEvent[] }

export function enrichRequest(domain: string, options: Pick<EnrichOptions, "limit" | "signalTypes" | "detectedAfter" | "now">) {
  const body: Record<string, unknown> = {
    domain,
    limit: options.limit ?? DEFAULT_SIGNAL_LIMIT,
    detected_after: options.detectedAfter ?? windowStart(options.now),
  }
  if (options.signalTypes?.length) body.signal_types = options.signalTypes
  return { endpoint: `${AUTOBOUND_BASE}/companies/enrich`, body }
}

// Evidence link, most specific first. website_url (the company site) is the last resort.
const URL_KEYS = [
  "url",
  "source_url",
  "sourceUrl",
  "article_url",
  "post_url",
  "postUrl",
  "product_hunt_url",
  "news_url",
  "page_url",
  "link",
  "permalink",
  "website_url",
]
const TITLE_KEYS = ["title", "headline", "post_title", "signal_name", "name"]
const TAG_KEYS = ["tags", "topic_tags", "topicTags", "ai_tags", "categories", "topics"]
const QUOTE_KEYS = ["summary", "description", "snippet", "text", "excerpt"]
const DATE_KEYS = [
  "published_at",
  "publishedAt",
  "occurred_at",
  "event_date",
  "signal_date",
  "date",
  "detected_at",
  "detectedAt",
  "created_at",
]

/** Finds the first string under any of `keys`, searching nested objects up to depth 3. */
function pick(value: unknown, keys: string[], depth = 0): string {
  if (!value || typeof value !== "object" || depth > 3) return ""
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const found = asString(record[key])
    if (found) return found
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const found = pick(nested, keys, depth + 1)
      if (found) return found
    }
  }
  return ""
}

function pickNumber(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const raw = record[key]
    if (typeof raw === "number" && Number.isFinite(raw)) return raw
  }
  return undefined
}

/** Provider-assigned tags (strings only), searched up to depth 3. Used for classification, never as evidence. */
function pickTags(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 3) return []
  const record = value as Record<string, unknown>
  const found: string[] = []
  for (const key of TAG_KEYS) {
    const raw = record[key]
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") found.push(item)
        else if (item && typeof item === "object") {
          const label = asString((item as Record<string, unknown>).name) || asString((item as Record<string, unknown>).label)
          if (label) found.push(label)
        }
      }
    }
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) found.push(...pickTags(nested, depth + 1))
  }
  return [...new Set(found)].slice(0, 20)
}

function signalArray(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return []
  const record = data as Record<string, unknown>
  for (const key of ["signals", "results", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[]
  }
  return []
}

/**
 * Turns an Autobound response into events. Nothing is inferred: a field the provider
 * does not return stays empty. A signal without an evidence URL is dropped and counted.
 */
export function eventsFromAutobound(
  data: unknown,
  domain: string,
  stageVersion = AUTOBOUND_STAGE_VERSION,
  runId?: string,
  now = new Date().toISOString()
): { events: SignalEvent[]; discarded: number } {
  const events: SignalEvent[] = []
  let discarded = 0
  for (const item of signalArray(data)) {
    const providerType = pick(item, ["signal_type", "signalType", "type"])
    const providerSubtype = pick(item, ["signal_subtype", "signalSubtype", "subtype"])
    const url = pick(item, URL_KEYS)
    if (!url || !/^https?:\/\//i.test(url)) {
      discarded += 1
      continue
    }
    // Classification uses the provider's type/subtype; when that is generic (news, posts, website
    // changes), the provider's own AI tags may refine it. Article text is never read for this.
    const byType = normalizeType(providerType, providerSubtype)
    const tags = pickTags(item)
    const byTags = tags.length ? normalizeType("", tags.join(" ")) : "other"
    const refinable = byType === "news" || byType === "other"
    const type = refinable && byTags !== "other" && byTags !== "news" && byTags !== "commercial_activity" ? byTags : byType
    const occurredAt = validDate(pick(item, DATE_KEYS))
    const providerValue = pickNumber(item, ["confidence", "confidence_score", "score"])
    events.push({
      id: eventId("autobound", type, url, occurredAt),
      type,
      subtype: [providerType, providerSubtype].filter(Boolean).join("/") || "unspecified",
      classifiedBy: type !== byType ? "provider_tags" : "provider_type",
      providerTags: tags.length ? tags : undefined,
      occurredAt,
      detectedAt: now,
      source: "autobound",
      sourceSignalId: pick(item, ["signal_id", "signalId", "id"]) || undefined,
      // Autobound was queried by the exact company domain, so identity is domain-matched.
      confidence: confidenceFor({ url, occurredAt, domainMatched: Boolean(domainOf(domain)), providerValue }),
      evidence: {
        url,
        title: clip(pick(item, TITLE_KEYS), 200) || undefined,
        quote: clip(pick(item, QUOTE_KEYS), 280) || undefined,
      },
      stageVersion,
      runId,
    })
  }
  return { events, discarded }
}

export function typeStatuses(
  events: SignalEvent[],
  fallback: SignalTypeStatus,
  only: SignalType[] = SIGNAL_TYPES.filter((type) => type !== "buyer_intent")
): SignalScan["types"] {
  const types: SignalScan["types"] = {}
  for (const type of only) {
    types[type] = events.some((event) => event.type === type) ? "found" : fallback
  }
  return types
}

function creditHeaders(response: Response): Record<string, string> | undefined {
  const found: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (/credit/i.test(name)) found[name] = value
  })
  return Object.keys(found).length ? found : undefined
}

/** One enrich call for one company. Never throws: failures are recorded on the scan. */
export async function enrichCompany(domainOrUrl: string, options: EnrichOptions): Promise<EnrichResult> {
  const startedAt = (options.now ?? new Date()).toISOString()
  const domain = domainOf(domainOrUrl)
  const limit = options.limit ?? DEFAULT_SIGNAL_LIMIT
  const worstCase = limit * CREDITS_PER_SIGNAL_WORST_CASE
  const base = {
    stageVersion: AUTOBOUND_STAGE_VERSION,
    source: "autobound" as const,
    runId: options.runId,
    startedAt,
    creditsEstimated: 0,
    eventsAdded: 0,
    discarded: 0,
  }
  if (!domain) {
    return {
      events: [],
      scan: { ...base, finishedAt: startedAt, status: "skipped_no_domain", types: {}, error: "Lead sem domínio." },
    }
  }
  const request = enrichRequest(domain, { ...options, limit })
  if (options.dryRun) {
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: startedAt,
        status: "dry_run",
        types: typeStatuses([], "not_requested"),
        creditsEstimated: worstCase,
        request,
      },
    }
  }
  if (!options.budget.canAfford(worstCase)) {
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: startedAt,
        status: "skipped_budget",
        types: typeStatuses([], "skipped_budget"),
        request,
        error: `Teto de créditos: restam ${options.budget.remaining}, a chamada pode custar até ${worstCase}.`,
      },
    }
  }
  if (!options.key) {
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: startedAt,
        status: "error",
        types: typeStatuses([], "error"),
        request,
        error: "AUTOBOUND_API_KEY ausente.",
      },
    }
  }
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000)
  // Reserve the worst case before the call so parallel callers cannot overspend.
  options.budget.charge(worstCase)
  try {
    const response = await doFetch(request.endpoint, {
      method: "POST",
      headers: { "x-api-key": options.key, "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    })
    const reported = creditHeaders(response)
    const text = await response.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    const finishedAt = new Date().toISOString()
    if (response.status === 404) {
      // Autobound documents 404 as "no signals for this company"; empty results are not billed.
      options.budget.release(worstCase)
      return {
        events: [],
        scan: { ...base, finishedAt, status: "done", types: typeStatuses([], "not_found"), creditsReported: reported, request },
      }
    }
    if (!response.ok) {
      options.budget.release(worstCase)
      throw new ApiError(`signals.autobound.ai returned ${response.status}: ${clip(text, 300)}`, response.status)
    }
    const parsed = eventsFromAutobound(data, domain, AUTOBOUND_STAGE_VERSION, options.runId, finishedAt)
    const returned = signalArray(data).length
    const actual = returned * CREDITS_PER_SIGNAL_WORST_CASE
    // Release the reservation and keep the worst-case charge for what was actually returned.
    options.budget.release(worstCase)
    options.budget.charge(actual)
    return {
      events: parsed.events,
      scan: {
        ...base,
        finishedAt,
        status: "done",
        types: typeStatuses(parsed.events, "not_found"),
        creditsEstimated: actual,
        creditsReported: reported,
        discarded: parsed.discarded,
        request,
      },
    }
  } catch (error) {
    // On a timeout the provider may still have processed (and billed) the call: keep the reservation.
    const timedOut = error instanceof Error && error.name === "AbortError"
    if (!(error instanceof ApiError) && !timedOut) options.budget.release(worstCase)
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Autobound não respondeu dentro do tempo limite."
        : error instanceof Error
          ? error.message
          : String(error)
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: new Date().toISOString(),
        status: "error",
        types: typeStatuses([], "error"),
        request,
        error: clip(message, 300),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Free metadata endpoints (no credit cost per Autobound docs). Used by the test script only. */
export async function freeMetadata(
  path: "/signal-types" | "/signals/types" | "/credits",
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetchImpl(`${AUTOBOUND_BASE}${path}`, {
    method: "GET",
    headers: { "x-api-key": key },
  })
  const text = await response.text()
  let data: unknown = text
  try {
    data = JSON.parse(text)
  } catch {
    data = clip(text, 500)
  }
  return { ok: response.ok, status: response.status, data }
}

export function plannedTypes(): SignalType[] {
  return [...SIGNAL_TYPES]
}
