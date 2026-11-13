import type { SignalEvent, SignalScan } from "../types"
import { asString, clip, domainOf } from "../text"
import { AUTOBOUND_BASE, AUTOBOUND_STAGE_VERSION, CreditBudget } from "./autobound"
import { eventId, validDate } from "./events"

/**
 * Autobound company buyer intent timeline:
 *   GET /v1/buyer-intent/companies/{domain}/timeline?topic_ids=a,b&weeks=N
 * Cost is documented two ways (free in the fall-2026 changelog; 1 credit per company-topic
 * row on the pricing page). The budget uses the worst case: 1 credit per requested topic.
 * Intent is aggregated provider data, not a public page: the event's evidence URL is the
 * API record reference and says so.
 */
export const INTENT_CREDITS_PER_TOPIC_WORST_CASE = 1
export const DEFAULT_INTENT_WEEKS = 8

export function intentTopics(): string[] {
  return (process.env.AUTOBOUND_INTENT_TOPICS ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function intentRequest(domain: string, topicIds: string[], weeks = DEFAULT_INTENT_WEEKS) {
  const params = new URLSearchParams({ topic_ids: topicIds.join(","), weeks: String(weeks) })
  return {
    endpoint: `${AUTOBOUND_BASE}/buyer-intent/companies/${encodeURIComponent(domain)}/timeline?${params.toString()}`,
    body: { domain, topic_ids: topicIds, weeks } as Record<string, unknown>,
  }
}

type Point = { at?: string; score?: number; stage?: string }

function num(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function str(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = asString(record[key])
    if (value) return value
  }
  return ""
}

const SCORE_KEYS = ["composite_score", "intent_score", "score", "surge_score"]
const STAGE_KEYS = ["buying_stage", "stage", "stage_label"]
const DATE_KEYS = ["week", "week_start", "week_of", "date", "period_start", "detected_at"]
const TOPIC_ID_KEYS = ["topic_id", "topicId"]
const TOPIC_NAME_KEYS = ["topic_name", "topicName", "topic"]

function point(record: Record<string, unknown>): Point | null {
  const score = num(record, SCORE_KEYS)
  const stage = str(record, STAGE_KEYS)
  if (score === undefined && !stage) return null
  return { at: validDate(str(record, DATE_KEYS)), score, stage: stage || undefined }
}

/**
 * Finds topic groups in the response without assuming one exact schema. Each group yields at
 * most one event: its latest week. Fields the provider does not return stay empty.
 */
export function intentEventsFromTimeline(
  data: unknown,
  domain: string,
  endpoint: string,
  runId?: string,
  now = new Date().toISOString()
): SignalEvent[] {
  const groups: { topicId: string; topicName: string; points: Point[] }[] = []
  const visit = (value: unknown, inherited: { topicId: string; topicName: string }) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, inherited))
      return
    }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    const topicId = str(record, TOPIC_ID_KEYS)
    const topicName = str(record, TOPIC_NAME_KEYS)
    const here = topicId || topicName ? { topicId: topicId || inherited.topicId, topicName: topicName || inherited.topicName } : inherited
    const own = point(record)
    if (own && (here.topicId || here.topicName)) {
      let group = groups.find((item) => item.topicId === here.topicId && item.topicName === here.topicName)
      if (!group) {
        group = { ...here, points: [] }
        groups.push(group)
      }
      group.points.push(own)
    }
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") visit(nested, here)
    }
  }
  visit(data, { topicId: "", topicName: "" })

  const events: SignalEvent[] = []
  for (const group of groups) {
    const latest = [...group.points].sort((left, right) => Date.parse(right.at ?? "") - Date.parse(left.at ?? "") || 0)[0]
    if (!latest) continue
    const label = group.topicName || group.topicId
    const quote = [
      `Tópico: ${label}`,
      latest.score !== undefined ? `nota ${latest.score}` : "",
      latest.stage ? `etapa ${latest.stage}` : "",
      `${group.points.length} semana(s) no histórico`,
      "Fonte: API Autobound (dado agregado de intenção, não é página pública)",
    ]
      .filter(Boolean)
      .join(" · ")
    events.push({
      id: eventId("autobound", "buyer_intent", `${endpoint}#${group.topicId || label}`, latest.at),
      type: "buyer_intent",
      subtype: `buyer-intent/${latest.stage || "unstaged"}`,
      occurredAt: latest.at,
      detectedAt: now,
      source: "autobound",
      sourceSignalId: group.topicId || undefined,
      confidence: {
        level: latest.at ? "medium" : "low",
        providerValue: latest.score,
        basis: "Dado agregado de intenção do provedor, resolvido pelo domínio; sem página pública de evidência.",
      },
      evidence: { url: endpoint, title: clip(`Intenção de compra: ${label}`, 200), quote: clip(quote, 280) },
      stageVersion: AUTOBOUND_STAGE_VERSION,
      runId,
    })
  }
  return events
}

export type IntentOptions = {
  key?: string
  budget: CreditBudget
  topicIds: string[]
  weeks?: number
  dryRun?: boolean
  runId?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/** One timeline call for one company. Never throws: failures are recorded on the scan. */
export async function intentTimeline(
  domainOrUrl: string,
  options: IntentOptions
): Promise<{ scan: SignalScan; events: SignalEvent[] }> {
  const startedAt = new Date().toISOString()
  const domain = domainOf(domainOrUrl)
  const worstCase = options.topicIds.length * INTENT_CREDITS_PER_TOPIC_WORST_CASE
  const base = {
    stageVersion: AUTOBOUND_STAGE_VERSION,
    source: "autobound" as const,
    endpoint: "intent_timeline" as const,
    runId: options.runId,
    startedAt,
    creditsEstimated: 0,
    eventsAdded: 0,
    discarded: 0,
  }
  if (!options.topicIds.length) {
    return { events: [], scan: { ...base, finishedAt: startedAt, status: "skipped_no_topics", types: {}, error: "Nenhum tópico de intenção configurado." } }
  }
  if (!domain) {
    return { events: [], scan: { ...base, finishedAt: startedAt, status: "skipped_no_domain", types: {}, error: "Lead sem domínio." } }
  }
  const request = intentRequest(domain, options.topicIds, options.weeks)
  const safeRequest = { endpoint: request.endpoint, body: request.body }
  if (options.dryRun) {
    return {
      events: [],
      scan: { ...base, finishedAt: startedAt, status: "dry_run", types: { buyer_intent: "not_requested" }, creditsEstimated: worstCase, request: safeRequest },
    }
  }
  if (!options.budget.canAfford(worstCase)) {
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: startedAt,
        status: "skipped_budget",
        types: { buyer_intent: "skipped_budget" },
        request: safeRequest,
        error: `Teto de créditos: restam ${options.budget.remaining}, a chamada pode custar até ${worstCase}.`,
      },
    }
  }
  if (!options.key) {
    return { events: [], scan: { ...base, finishedAt: startedAt, status: "error", types: { buyer_intent: "error" }, request: safeRequest, error: "AUTOBOUND_API_KEY ausente." } }
  }
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000)
  options.budget.charge(worstCase)
  try {
    const response = await doFetch(request.endpoint, {
      method: "GET",
      headers: { "x-api-key": options.key },
      signal: controller.signal,
    })
    const text = await response.text()
    const finishedAt = new Date().toISOString()
    const reported: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      if (/credit/i.test(name)) reported[name] = value
    })
    const creditsReported = Object.keys(reported).length ? reported : undefined
    if (response.status === 404) {
      options.budget.release(worstCase)
      return { events: [], scan: { ...base, finishedAt, status: "done", types: { buyer_intent: "not_found" }, creditsReported, request: safeRequest } }
    }
    if (!response.ok) {
      options.budget.release(worstCase)
      return {
        events: [],
        scan: { ...base, finishedAt, status: "error", types: { buyer_intent: "error" }, creditsReported, request: safeRequest, error: clip(`signals.autobound.ai returned ${response.status}: ${text}`, 300) },
      }
    }
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    const events = intentEventsFromTimeline(data, domain, request.endpoint, options.runId, finishedAt)
    // Worst case kept: one credit per requested topic (rows returned may be fewer).
    return {
      events,
      scan: {
        ...base,
        finishedAt,
        status: "done",
        types: { buyer_intent: events.length ? "found" : "not_found" },
        creditsEstimated: worstCase,
        creditsReported,
        request: safeRequest,
      },
    }
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError"
    if (!timedOut) options.budget.release(worstCase)
    return {
      events: [],
      scan: {
        ...base,
        finishedAt: new Date().toISOString(),
        status: "error",
        types: { buyer_intent: "error" },
        creditsEstimated: timedOut ? worstCase : 0,
        request: safeRequest,
        error: timedOut ? "Autobound não respondeu dentro do tempo limite." : clip(error instanceof Error ? error.message : String(error), 300),
      },
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Topic search for discovering topic ids (live test only). Cost is not documented; the script reports it. */
export async function searchIntentTopics(query: string, key: string, fetchImpl: typeof fetch = fetch) {
  const params = new URLSearchParams({ q: query, page_size: "10" })
  const response = await fetchImpl(`${AUTOBOUND_BASE}/buyer-intent/topics?${params.toString()}`, {
    method: "GET",
    headers: { "x-api-key": key },
  })
  const text = await response.text()
  let data: unknown = clip(text, 500)
  try {
    data = JSON.parse(text)
  } catch {
    // keep clipped text
  }
  const credits: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (/credit/i.test(name)) credits[name] = value
  })
  return { ok: response.ok, status: response.status, data, credits }
}
