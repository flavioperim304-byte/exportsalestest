import type { ActivityKind, ActivitySignal, ActivitySnapshot, Brief, Lead } from "./types"
import { ApiError, requestJson } from "./http"
import { asString, clip, domainOf, sameSite } from "./text"

export const ACTIVITY_MONTHS = 24

const SOCIAL =
  /(?:^|\.)(?:instagram|facebook|linkedin|tiktok|youtube|x|twitter)\.com$/i

const LAUNCH =
  /\b(lan[cç]amento|lan[cç]ou|launch(?:ed|ing|es)?|unveiled|new (?:product|line|range|collection|kit))\b/i

const BRAND =
  /\b(nova marca|new brand|signed (?:a )?(?:new )?brand|exclusive (?:distribution|import|line)|brand portfolio|portfolio expansion|added (?:the )?brand)\b/i

const KIND_LABEL: Record<ActivityKind, string> = {
  news: "notícia",
  launch: "lançamento",
  promotion: "promoção",
  exhibition: "feira / exposição",
  event: "evento",
  mention: "menção",
  brand: "nova marca",
  social: "rede social",
  social_growth: "crescimento em rede",
  mix_change: "mudança de mix",
}

const SOCIAL_GROWTH =
  /\b(seguidores|followers|follower count|crescimento|engajamento cresceu|growing (?:on|its) (?:instagram|facebook|tiktok|linkedin))\b/i
const MIX_CHANGE =
  /\b(mudou o mix|mix de produtos|new (?:sku|range|collection)|dropped (?:the )?brand|tirou a marca|added .{0,40}(?:to|ao) (?:the )?(?:portfolio|portf[oó]lio)|discontinued|portf[oó]lio mudou|portfolio change|perdeu a exclusividade|lost exclusivity|ended (?:the )?distribution|left the portfolio)\b/i
const EXHIBITION =
  /\b(cosmoprof|beautyworld|in-cosmetics|expocosmetica|exhibition|exhibitor|trade fair|feira|feria (?:de|internacional|beauty)|stand (?:n[úu]mero|no\.?))\b/i
const PROMOTION =
  /\b(promo(?:tion|ção|cion)|discount|desconto|campaign|campanha|oferta|sale(?:s)? event)\b/i
const EVENT =
  /\b(webinar|workshop|conference|congresso|summit|open day|evento|event(?:o)?s?)\b/i
const MENTION =
  /\b(mencion(?:ed|ou|ado)|mentioned|cita(?:do|tion)|featured in|aparece(?:u)? (?:em|na|no))\b/i

const WINDOW_MS = ACTIVITY_MONTHS * 30 * 24 * 60 * 60 * 1000
const MARKET_SUFFIX = /\s+(?:mexico|mx|brazil|brasil)$/
const LEGAL_SUFFIX = /\b(?:s a de cv|s de r l de cv|s de rl de cv|sa de cv|s a|sa|ltda|llc|inc|corp|corporation|limited|ltd)\b/g

export function activityKindLabel(kind: ActivityKind): string {
  return KIND_LABEL[kind]
}

export function activityWindowStart(now = new Date()): string {
  const start = new Date(now)
  start.setMonth(start.getMonth() - ACTIVITY_MONTHS)
  return start.toISOString()
}

function normalizeName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function companyAliases(name: string): string[] {
  const aliases = new Set<string>()
  const segments = name.split(/[|/]/).map((part) => part.trim()).filter(Boolean)

  for (const segment of segments) {
    const normalized = normalizeName(segment)
    if (!normalized) continue
    aliases.add(normalized)

    const withoutLegalSuffix = normalized.replace(LEGAL_SUFFIX, " ").replace(/\s+/g, " ").trim()
    if (withoutLegalSuffix) aliases.add(withoutLegalSuffix)

    const withoutMarket = normalized.replace(MARKET_SUFFIX, "").trim()
    if (withoutMarket.split(" ").length >= 2) aliases.add(withoutMarket)

    const withoutBoth = withoutLegalSuffix.replace(MARKET_SUFFIX, "").trim()
    if (withoutBoth.split(" ").length >= 2) aliases.add(withoutBoth)
  }

  return [...aliases].filter((alias) => alias.length >= 4)
}

function isPersonProfile(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
    return host === "linkedin.com" && /^\/(?:in|pub)\//i.test(parsed.pathname)
  } catch {
    return false
  }
}

export function activityQuery(lead: Lead, brief: Brief): string {
  const market = lead.market || lead.country || brief.markets
  return [
    `"${lead.name}"`,
    market,
    '("new brand" OR "brand added" OR "brand portfolio" OR "new product line" OR launch OR lanzamiento OR lançamento OR "lost distribution" OR "lost exclusivity" OR discontinued OR "market share" OR "best seller" OR "top selling" OR "sales growth" OR competitor OR competencia OR concorrente OR followers OR seguidores)',
  ]
    .filter((part) => part.trim())
    .join(" ")
}

export function classifyActivity(url: string, title: string, text: string): ActivityKind {
  const host = domainOf(url)
  const blob = `${title} ${text}`

  // Classify the commercial event before its publishing channel.
  if (MIX_CHANGE.test(blob)) return "mix_change"
  if (LAUNCH.test(blob)) return "launch"
  if (BRAND.test(blob)) return "brand"
  if (PROMOTION.test(blob)) return "promotion"
  if (EXHIBITION.test(blob)) return "exhibition"
  if (EVENT.test(blob)) return "event"
  if (SOCIAL.test(host) && SOCIAL_GROWTH.test(blob)) return "social_growth"
  if (SOCIAL.test(host)) return "social"
  if (MENTION.test(blob)) return "mention"
  return "news"
}

export function mentionsCompany(lead: Lead, title: string, url: string, text: string): boolean {
  // The candidate's own domain is a direct identity match.
  if (sameSite(url, lead.url) || sameSite(url, lead.domain)) return true

  // External pages must contain the complete company name (or a clear trading-name
  // segment), not merely one common word from a multi-word company name.
  const haystack = ` ${normalizeName(`${title} ${url} ${text}`)} `
  const aliases = companyAliases(lead.name)
  return aliases.some((alias) => haystack.includes(` ${alias} `))
}

function publishedTimestamp(publishedAt: string | undefined): number | null {
  if (!publishedAt) return null
  const stamp = Date.parse(publishedAt)
  return Number.isFinite(stamp) ? stamp : null
}

function isRecent(publishedAt: string | undefined, fetchedAt: string): boolean {
  const stamp = publishedTimestamp(publishedAt)
  if (stamp === null) return false
  const parsedFetched = Date.parse(fetchedAt)
  const end = Number.isFinite(parsedFetched) ? parsedFetched : Date.now()
  return stamp <= end && end - stamp <= WINDOW_MS
}

export function signalsFromSearch(results: unknown[], lead: Lead): ActivitySignal[] {
  if (!Array.isArray(results)) return []

  const seen = new Set<string>()
  const signals: ActivitySignal[] = []

  for (const item of results) {
    const row = (item ?? {}) as Record<string, unknown>
    const url = asString(row.url)
    const title = asString(row.title)
    const highlights = Array.isArray(row.highlights)
      ? row.highlights.map((part) => asString(part)).filter(Boolean)
      : []
    const text = asString(row.text) || highlights[0] || ""

    if (!url || !title || !mentionsCompany(lead, title, url, text)) continue
    if (isPersonProfile(url)) continue

    const kind = classifyActivity(url, title, text)
    const key = `${kind}|${url.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    signals.push({
      kind,
      title,
      url,
      publishedAt: asString(row.publishedDate) || undefined,
      quote: clip(highlights[0] || text || title, 220),
    })
  }

  return signals
    .sort((left, right) => {
      const leftDate = publishedTimestamp(left.publishedAt) ?? 0
      const rightDate = publishedTimestamp(right.publishedAt) ?? 0
      return rightDate - leftDate
    })
    .slice(0, 8)
}

export function recentSignals(activity: ActivitySnapshot | undefined): ActivitySignal[] {
  if (!activity) return []
  return (activity.signals ?? []).filter((signal) => isRecent(signal.publishedAt, activity.fetchedAt))
}

export function hasRecentActivity(lead: Lead): boolean {
  return recentSignals(lead.activity).length > 0
}

export function activityKinds(lead: Lead): ActivityKind[] {
  return [...new Set(recentSignals(lead.activity).map((signal) => signal.kind))]
}

export function activityLine(lead: Lead): string {
  if (!lead.activity) return "Public activity has not been searched."
  if (lead.activity.error && lead.activity.signals.length === 0) {
    return `Public activity search failed. ${lead.activity.error}`
  }

  const all = lead.activity.signals ?? []
  const recent = recentSignals(lead.activity)
  const undated = all.filter((signal) => publishedTimestamp(signal.publishedAt) === null).length
  const older = all.length - recent.length - undated

  if (recent.length === 0) {
    if (undated > 0) {
      return `${undated} public signal(s) found without a verifiable publication date; not counted as recent. ${older > 0 ? `${older} dated signal(s) fall outside the ${ACTIVITY_MONTHS}-month window.` : ""}`.trim()
    }
    return `No dated news, product launch, new brand, or social activity in the last ${ACTIVITY_MONTHS} months.`
  }

  const kinds = [...new Set(recent.map((signal) => activityKindLabel(signal.kind)))].join(", ")
  const undatedNote = undated > 0 ? ` ${undated} additional signal(s) have no verifiable date and were not counted.` : ""
  return `${recent.length} dated public ${recent.length === 1 ? "signal" : "signals"} in the last ${ACTIVITY_MONTHS} months: ${kinds}.${undatedNote}`
}

export function emptyActivity(error?: string): ActivitySnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    signals: [],
    error,
  }
}

export async function searchActivity(lead: Lead, brief: Brief, key: string): Promise<ActivitySnapshot> {
  const data = await requestJson("https://api.exa.ai/search", {
    method: "POST",
    timeoutMs: 25000,
    headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    body: JSON.stringify({
      query: activityQuery(lead, brief),
      type: "auto",
      numResults: 8,
      startPublishedDate: activityWindowStart(),
      contents: {
        text: { maxCharacters: 400 },
        highlights: { maxHighlights: 1, maxCharacters: 180 },
      },
    }),
  })

  const results = (data as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) {
    throw new ApiError("Exa activity search did not return results.", 502)
  }

  return {
    fetchedAt: new Date().toISOString(),
    signals: signalsFromSearch(results, lead),
  }
}
