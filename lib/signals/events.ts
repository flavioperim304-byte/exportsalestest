import type {
  ActivitySignal,
  CommerceSignal,
  Lead,
  SignalConfidence,
  SignalEvent,
  SignalSource,
  SignalType,
} from "../types"
import { sameSite } from "../text"

export const SIGNAL_TYPES: SignalType[] = [
  "hiring",
  "expansion",
  "product_launch",
  "event",
  "news",
  "commercial_activity",
  "buyer_intent",
  "other",
]

export const SIGNAL_TYPE_LABEL: Record<SignalType, string> = {
  hiring: "contratação",
  expansion: "expansão",
  product_launch: "lançamento de produto",
  event: "evento / feira",
  news: "notícia",
  commercial_activity: "atividade comercial",
  buyer_intent: "intenção de compra",
  other: "outro",
}

/**
 * Maps a provider label to a normalized type. Only the provider's own type/subtype
 * strings are read — never the article text — so classification adds no interpretation.
 */
export function normalizeType(providerType: string, providerSubtype = ""): SignalType {
  const label = `${providerType} ${providerSubtype}`.toLowerCase()
  if (/review|github|seo|traffic|tech.?stack|glassdoor/.test(label)) return "other"
  // Negative signals never count as an increase.
  if (/layoff|contraction|reduction|bankrupt|restructur|departure|closing|closure|shutdown/.test(label)) return "other"
  if (/conference|webinar|\bevents?\b|exhibit|trade.?show|trade.?fair|\bexpo\b|summit/.test(label)) return "event"
  if (/hir|job|recruit|headcount|vacanc|new.?role|appointment/.test(label)) return "hiring"
  if (/expan|office|opening|new.?location|facility|warehouse|relocat|geograph|new.?market/.test(label)) return "expansion"
  if (/launch|new.?product|product.?release/.test(label)) return "product_launch"
  if (/partner|contract|customer|client|distribut|deal|acqui|merger|rfp|tender|award|brand/.test(label)) {
    return "commercial_activity"
  }
  if (/news/.test(label)) return "news"
  return "other"
}

/** Two independent FNV-1a 32-bit passes → 16 hex chars. Pure JS, so this module also runs in the browser bundle. */
function stableHash(text: string): string {
  let left = 0x811c9dc5
  let right = 0x01000193 ^ text.length
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    left = Math.imul(left ^ code, 0x01000193) >>> 0
    right = Math.imul(right ^ ((code * 31 + index) & 0xffff), 0x01000193) >>> 0
  }
  return left.toString(16).padStart(8, "0") + right.toString(16).padStart(8, "0")
}

export function eventId(source: SignalSource, type: SignalType, url: string, occurredAt?: string): string {
  const key = [source, type, url.trim().toLowerCase(), occurredAt ?? ""].join("|")
  return stableHash(key)
}

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined
}

/**
 * Confidence rule (approved for Phase 1):
 * - high: evidence URL + date + identity matched by domain (URL on the company domain,
 *   or the provider resolved the company by its exact domain)
 * - medium: evidence URL + identity by domain, but no date
 * - low: company identified only by name on an external page
 * A provider-supplied value is kept unchanged in `providerValue`.
 */
export function confidenceFor(input: {
  url: string
  occurredAt?: string
  domainMatched: boolean
  providerValue?: number
}): SignalConfidence {
  const providerValue =
    typeof input.providerValue === "number" && Number.isFinite(input.providerValue)
      ? input.providerValue
      : undefined
  if (!input.domainMatched) {
    return { level: "low", providerValue, basis: "Empresa identificada só pelo nome numa página externa." }
  }
  if (input.occurredAt) {
    return { level: "high", providerValue, basis: "URL de evidência, data e identidade pelo domínio." }
  }
  return { level: "medium", providerValue, basis: "URL de evidência e identidade pelo domínio, sem data." }
}

/** Appends new events; an id already stored is never overwritten. Returns how many were added. */
export function appendEvents(lead: Lead, events: SignalEvent[]): number {
  const existing = lead.signalEvents ?? []
  const seen = new Set(existing.map((event) => event.id))
  let added = 0
  for (const event of events) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    existing.push(event)
    added += 1
  }
  lead.signalEvents = existing
  return added
}

/** Events present on `next` but not on `previous` — used to mirror only new rows to desk_lead_events. */
export function newSignalEvents(previous: Lead | null | undefined, next: Lead): SignalEvent[] {
  const before = new Set((previous?.signalEvents ?? []).map((event) => event.id))
  return (next.signalEvents ?? []).filter((event) => !before.has(event.id))
}

const ACTIVITY_TYPE: Record<ActivitySignal["kind"], SignalType> = {
  news: "news",
  launch: "product_launch",
  promotion: "commercial_activity",
  exhibition: "event",
  event: "event",
  mention: "news",
  brand: "commercial_activity",
  social: "other",
  social_growth: "other",
  mix_change: "commercial_activity",
}

const COMMERCE_TYPE: Record<CommerceSignal["kind"], SignalType> = {
  customs: "commercial_activity",
  restock: "commercial_activity",
  trade_fair: "event",
  open_book: "commercial_activity",
  hiring_buy: "hiring",
}

/**
 * Converts the signals the current Exa stages already stored into events (source "exa").
 * Read-only on lead.activity / lead.commerce: those fields stay exactly as they are.
 * Only Exa-sourced commerce rows are converted; trade-record / Atlas lines are not web signals.
 */
export function eventsFromExa(lead: Lead, stageVersion: string, runId?: string, now = new Date().toISOString()): SignalEvent[] {
  const rows: { kind: string; type: SignalType; signal: ActivitySignal | CommerceSignal }[] = []
  for (const signal of lead.activity?.signals ?? []) {
    rows.push({ kind: `activity/${signal.kind}`, type: ACTIVITY_TYPE[signal.kind] ?? "other", signal })
  }
  for (const signal of lead.commerce?.signals ?? []) {
    if (signal.source && signal.source !== "exa") continue
    rows.push({ kind: `commerce/${signal.kind}`, type: COMMERCE_TYPE[signal.kind] ?? "other", signal })
  }
  const events: SignalEvent[] = []
  for (const row of rows) {
    const url = row.signal.url
    if (!url) continue
    const occurredAt = validDate(row.signal.publishedAt)
    const onDomain = sameSite(url, lead.url) || sameSite(url, lead.domain)
    events.push({
      id: eventId("exa", row.type, url, occurredAt),
      type: row.type,
      subtype: row.kind,
      occurredAt,
      detectedAt: now,
      source: "exa",
      confidence: confidenceFor({ url, occurredAt, domainMatched: onDomain }),
      evidence: { url, title: row.signal.title || undefined, quote: row.signal.quote || undefined },
      stageVersion,
      runId,
    })
  }
  return events
}

export { validDate }
