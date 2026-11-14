import type { Brief, ContactField, Extraction } from "./types"
import { ApiError, requestJson } from "./http"
import { firecrawlPrompt } from "./prompts"
import { asString, asStringArray, clip } from "./text"

const SCHEMA = {
  type: "object",
  properties: {
    companyName: { type: "string" },
    headquarters: { type: "string" },
    country: { type: "string" },
    role: {
      type: "string",
      description:
        "importer, distributor, wholesaler, trader, roaster, retailer, producer, exporter, or other",
    },
    buys: { type: "array", items: { type: "string" } },
    sells: { type: "array", items: { type: "string" } },
    markets: { type: "array", items: { type: "string" } },
    certifications: { type: "array", items: { type: "string" } },
    buyerSignals: {
      type: "array",
      items: { type: "string" },
      description: "Short phrases from the page about buying, importing, or distribution",
    },
    lastPurchase: {
      type: "string",
      description: "Last inbound purchase or shipment, only if the page states it. Empty otherwise.",
    },
    stock: {
      type: "string",
      description: "Stock or restock language, only if the page states it. Empty otherwise.",
    },
    brandPerformance: {
      type: "string",
      description: "How current brands are performing, only if the page states it. Empty otherwise.",
    },
    salesNote: {
      type: "string",
      description: "Published sales or volume, with the year if given. Empty when unpublished.",
    },
    competitorMoves: {
      type: "array",
      items: { type: "string" },
      description: "Competitor launches, lost brands, or exclusive moves named on the page.",
    },
    summary: { type: "string" },
    email: { type: "string", description: "Published email. Empty when none is published." },
    phone: { type: "string", description: "Published phone. Empty when none is published." },
    whatsapp: { type: "string", description: "Published WhatsApp number. Empty when none is published." },
    website: { type: "string", description: "Company website." },
    keyPerson: {
      type: "string",
      description: "Published key person (purchasing, owner, or export contact). Empty when unpublished.",
    },
    keyPersonRole: {
      type: "string",
      description: "Role of that key person. Empty when unpublished.",
    },
    latestHires: {
      type: "array",
      items: { type: "string" },
      description: "Latest published hires or job ads. Empty when unpublished.",
    },
  },
}

function empty(error: string): Extraction {
  return {
    ok: false,
    error,
    companyName: "",
    headquarters: "",
    country: "",
    role: "",
    buys: [],
    sells: [],
    markets: [],
    certifications: [],
    buyerSignals: [],
    lastPurchase: "",
    stock: "",
    brandPerformance: "",
    salesNote: "",
    competitorMoves: [],
    summary: "",
    excerpt: "",
    email: "",
    phone: "",
    whatsapp: "",
    website: "",
    keyPerson: "",
    keyPersonRole: "",
    latestHires: [],
  }
}

export function failedExtraction(error: string): Extraction {
  return empty(error)
}

function contacts(json: Record<string, unknown>) {
  return {
    email: asString(json.email),
    phone: asString(json.phone),
    whatsapp: asString(json.whatsapp || json.whatsApp),
    website: asString(json.website),
    keyPerson: asString(json.keyPerson || json.contactName || json.person),
    keyPersonRole: asString(json.keyPersonRole || json.contactRole),
    latestHires: asStringArray(json.latestHires || json.hiring).slice(0, 6),
  }
}

export function profileFromAgent(data: unknown): Extraction | null {
  if (!data || typeof data !== "object") return null
  const root = data as { data?: unknown; json?: unknown }
  const payload = (root.data ?? root.json ?? data) as Record<string, unknown>
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const summary = asString(payload.summary)
  const companyName = asString(payload.companyName)
  if (!summary && !companyName && !asString(payload.role)) return null
  return {
    ok: true,
    companyName,
    headquarters: asString(payload.headquarters),
    country: asString(payload.country),
    role: asString(payload.role),
    buys: asStringArray(payload.buys).slice(0, 8),
    sells: asStringArray(payload.sells).slice(0, 8),
    markets: asStringArray(payload.markets).slice(0, 8),
    certifications: asStringArray(payload.certifications).slice(0, 8),
    buyerSignals: asStringArray(payload.buyerSignals).slice(0, 4),
    lastPurchase: asString(payload.lastPurchase),
    stock: asString(payload.stock),
    brandPerformance: asString(payload.brandPerformance),
    salesNote: asString(payload.salesNote),
    competitorMoves: asStringArray(payload.competitorMoves).slice(0, 4),
    summary,
    excerpt: clip(summary, 1600),
    ...contacts(payload),
  }
}

export const EXTRACT_PAGE_MS = 70_000
export const EXTRACT_STAGE_MS = 8 * 60 * 1000
export const EXTRACT_POLL_MS = 4_000

const TIMEOUT_MESSAGE = "Firecrawl took too long. Scoring uses the Exa excerpt."

export function jobTimedOut(startedAt: string | undefined, now = Date.now(), limit = EXTRACT_PAGE_MS): boolean {
  if (!startedAt) return false
  const started = Date.parse(startedAt)
  return Number.isFinite(started) && now - started >= limit
}

export function stageTimedOut(startedAt: string | undefined, now = Date.now()): boolean {
  return jobTimedOut(startedAt, now, EXTRACT_STAGE_MS)
}

function extractStatus(data: unknown): string {
  return String(((data ?? {}) as { status?: string }).status ?? "").toLowerCase()
}

function extractSettled(data: unknown): boolean {
  const status = extractStatus(data)
  return status === "completed" || status === "failed" || status === "cancelled" || status === "canceled"
}

function crawlUrls(pageUrl: string): string[] {
  try {
    const origin = new URL(pageUrl).origin
    return origin === pageUrl || pageUrl === `${origin}/` ? [`${origin}/*`] : [pageUrl, `${origin}/*`]
  } catch {
    return [pageUrl]
  }
}

function extractBody(url: string, brief: Brief, country: string, buyerType: string) {
  return {
    urls: crawlUrls(url),
    prompt: firecrawlPrompt(brief, country, buyerType),
    schema: SCHEMA,
    enableWebSearch: true,
    ignoreSitemap: false,
    scrapeOptions: { onlyMainContent: true },
  }
}

async function extractResult(key: string, started: unknown): Promise<unknown> {
  const record = (started ?? {}) as { id?: string; status?: string; data?: unknown }
  if ((record.status === "completed" || !record.id) && record.data) return started
  const id = record.id
  if (!id) return started
  const deadline = Date.now() + 55_000
  let latest: unknown = started
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXTRACT_POLL_MS))
    latest = await requestJson(`https://api.firecrawl.dev/v2/extract/${id}`, {
      method: "GET",
      timeoutMs: 20000,
      headers: { Authorization: `Bearer ${key}` },
    })
    if (extractSettled(latest)) return latest
  }
  return latest
}

function profileFromScrape(data: unknown): Extraction | null {
  if (!data || typeof data !== "object") return null
  const record = data as { data?: Record<string, unknown>; json?: unknown }
  const inner = record.data && typeof record.data === "object" ? record.data : (data as Record<string, unknown>)
  return (
    profileFromAgent({ data: inner.json ?? inner.extract ?? inner }) ||
    profileFromAgent({ data: record.json }) ||
    profileFromAgent(data)
  )
}

export async function extractPage(
  url: string,
  brief: Brief,
  key: string,
  country = "",
  buyerType = ""
): Promise<Extraction> {
  if (!/^https?:\/\//i.test(url)) {
    return empty("The lead has no http(s) page to read.")
  }

  const started = await requestJson("https://api.firecrawl.dev/v2/extract", {
    method: "POST",
    timeoutMs: 25000,
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify(extractBody(url, brief, country, buyerType)),
  })

  const data = await extractResult(key, started)
  const fromExtract = extractionFromExtract(data, url)
  if (fromExtract.ok || (fromExtract.error && !fromExtract.error.includes("neither a profile"))) {
    if (fromExtract.ok) return fromExtract
    if (extractSettled(data)) return fromExtract
  }
  const scraped = await scrapeProfile(url, brief, key, country, buyerType)
  if (scraped.ok) return scraped
  if (!extractSettled(data)) return empty(TIMEOUT_MESSAGE)
  return fromExtract.error ? fromExtract : scraped
}

function extractionFromExtract(data: unknown, pageUrl: string): Extraction {
  if (!data || typeof data !== "object") return empty("Firecrawl extract returned an empty body.")
  const record = data as { success?: boolean; status?: string; error?: string; data?: unknown }
  const status = extractStatus(data)
  if (record.success === false || status === "failed" || status === "cancelled" || status === "canceled") {
    return empty(record.error || "Firecrawl could not scrape or crawl this company.")
  }
  const payload = Array.isArray(record.data) ? record.data[0] : record.data
  const profile = profileFromAgent(payload ? { data: payload } : data)
  if (!profile) return empty("Firecrawl scrape/crawl returned neither a profile nor contacts.")
  if (!profile.website) profile.website = pageUrl
  return profile
}

export async function scrapeProfile(
  url: string,
  brief: Brief,
  key: string,
  country = "",
  buyerType = ""
): Promise<Extraction> {
  if (!/^https?:\/\//i.test(url)) {
    return empty("The lead has no http(s) page to read.")
  }
  try {
    const data = await requestJson("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      timeoutMs: 25000,
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: [
          {
            type: "json",
            prompt: firecrawlPrompt(brief, country, buyerType),
            schema: SCHEMA,
          },
        ],
      }),
    })
    const profile = profileFromScrape(data)
    if (!profile) return empty("Firecrawl scrape returned neither a profile nor contacts.")
    if (!profile.website) profile.website = url
    return profile
  } catch (error) {
    return empty(error instanceof Error ? error.message : "Firecrawl scrape failed.")
  }
}

/**
 * Company read (phase B, measured on 14/11/2026): map the site, then scrape the home page and
 * the contact page with header and footer, using the same schema. Each contact keeps the URL
 * of the page that published it.
 */
export const READ_LEAD_MS = 60_000
export const READ_CONCURRENCY = 3
const MAP_TIMEOUT_MS = 15_000
const SCRAPE_TIMEOUT_MS = 30_000
const CONTACT_FIELDS: ContactField[] = ["email", "phone", "whatsapp", "website", "keyPerson", "keyPersonRole"]
const CONTACT_PAGE = /contact|contacto|cont[aá]ct[ae]nos|contato|fale-conosco|kontakt/i
const READ_TIMEOUT_MESSAGE = "Firecrawl took too long. Scoring uses the Exa excerpt."

/** Lowest published Firecrawl plan limit (10 scrapes per minute) unless FIRECRAWL_SCRAPES_PER_MINUTE says otherwise. */
function scrapeSpacingMs(): number {
  const perMinute = Number(process.env.FIRECRAWL_SCRAPES_PER_MINUTE)
  return Math.ceil(60_000 / (Number.isFinite(perMinute) && perMinute > 0 ? perMinute : 10))
}

let nextScrapeAt = 0
async function scrapeSlot(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, nextScrapeAt)
  nextScrapeAt = at + scrapeSpacingMs()
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now))
}

function sameUrl(left: string, right: string): boolean {
  return left.replace(/\/+$/, "").toLowerCase() === right.replace(/\/+$/, "").toLowerCase()
}

/** The first mapped link that looks like a contact page, other than the home page. */
export function findContactPage(data: unknown, home: string): string | undefined {
  const links = ((data ?? {}) as { links?: unknown }).links
  if (!Array.isArray(links)) return undefined
  for (const link of links) {
    const url = typeof link === "string" ? link : asString((link as { url?: unknown })?.url)
    if (url && CONTACT_PAGE.test(url) && !sameUrl(url, home)) return url
  }
  return undefined
}

function pageProfile(json: Record<string, unknown>): Extraction | null {
  const profile = profileFromAgent({ data: json })
  if (profile) return profile
  const found = contacts(json)
  return CONTACT_FIELDS.some((field) => found[field]) ? { ...empty(""), ok: true, error: undefined, ...found } : null
}

function union(left: string[] = [], right: string[] = [], max = 8): string[] {
  return [...new Set([...left, ...right].map((item) => item.trim()).filter(Boolean))].slice(0, max)
}

/**
 * Merges the pages read for one lead. Contacts prefer the contact page and record the page URL.
 * Profile text comes from the home page, then the contact page. Lists are joined.
 */
export function mergePages(pages: { url: string; json: Record<string, unknown> | null }[]): Extraction | null {
  const read = pages
    .map((page) => ({ url: page.url, profile: page.json ? pageProfile(page.json) : null }))
    .filter((page): page is { url: string; profile: Extraction } => Boolean(page.profile))
  if (!read.length) return null
  const [first, ...rest] = read
  const merged: Extraction = { ...first.profile }
  for (const page of rest) {
    const other = page.profile
    for (const key of ["companyName", "headquarters", "country", "role", "summary", "lastPurchase", "stock", "brandPerformance", "salesNote"] as const) {
      if (!merged[key] && other[key]) merged[key] = other[key]
    }
    merged.buys = union(merged.buys, other.buys)
    merged.sells = union(merged.sells, other.sells)
    merged.markets = union(merged.markets, other.markets)
    merged.certifications = union(merged.certifications, other.certifications)
    merged.buyerSignals = union(merged.buyerSignals, other.buyerSignals, 4)
    merged.competitorMoves = union(merged.competitorMoves, other.competitorMoves, 4)
    merged.latestHires = union(merged.latestHires, other.latestHires, 6)
  }
  merged.excerpt = clip(merged.summary, 1600)
  const sources: Partial<Record<ContactField, string>> = {}
  for (const field of CONTACT_FIELDS) {
    merged[field] = ""
    for (const page of [...read].reverse()) {
      const value = asString(page.profile[field]).trim()
      if (value) {
        merged[field] = value
        sources[field] = page.url
        break
      }
    }
  }
  merged.contactSources = sources
  merged.pagesRead = read.map((page) => page.url)
  merged.ok = true
  merged.error = undefined
  return merged
}

async function scrapePageJson(url: string, brief: Brief, key: string, country: string, buyerType: string) {
  const body = JSON.stringify({
    url,
    onlyMainContent: false,
    formats: [{ type: "json", prompt: firecrawlPrompt(brief, country, buyerType), schema: SCHEMA }],
  })
  for (let attempt = 0; ; attempt += 1) {
    await scrapeSlot()
    try {
      const data = await requestJson("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        timeoutMs: SCRAPE_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${key}` },
        body,
      })
      const inner = ((data ?? {}) as { data?: { json?: unknown } }).data
      const json = inner?.json
      return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null
    } catch (error) {
      // One retry on the plan's rate limit; everything else is reported to the caller.
      if (attempt === 0 && error instanceof ApiError && error.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs ?? 10_000))
        continue
      }
      throw error
    }
  }
}

async function readPages(url: string, brief: Brief, key: string, country: string, buyerType: string): Promise<Extraction> {
  let contactPage: string | undefined
  try {
    const map = await requestJson("https://api.firecrawl.dev/v2/map", {
      method: "POST",
      timeoutMs: MAP_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify({ url, search: "contact contacto contactenos contactanos contato", limit: 30 }),
    })
    contactPage = findContactPage(map, url)
  } catch {
    // Without the map, the home page is still read.
  }
  const urls = contactPage ? [url, contactPage] : [url]
  const settled = await Promise.allSettled(urls.map((page) => scrapePageJson(page, brief, key, country, buyerType)))
  const merged = mergePages(urls.map((page, index) => ({ url: page, json: settled[index].status === "fulfilled" ? settled[index].value : null })))
  if (merged) {
    if (!merged.website) merged.website = url
    return merged
  }
  const failure = settled.find((item): item is PromiseRejectedResult => item.status === "rejected")
  return empty(
    failure
      ? failure.reason instanceof Error
        ? failure.reason.message
        : "Firecrawl scrape failed."
      : "Firecrawl read the pages but found neither a profile nor contacts."
  )
}

/** Reads one lead within READ_LEAD_MS. Never throws. */
export async function readCompanyPages(
  url: string,
  brief: Brief,
  key: string,
  country = "",
  buyerType = "",
  limitMs = READ_LEAD_MS
): Promise<Extraction> {
  if (!/^https?:\/\//i.test(url)) return empty("The lead has no http(s) page to read.")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Extraction>((resolve) => {
    timer = setTimeout(() => resolve(empty(READ_TIMEOUT_MESSAGE)), limitMs)
  })
  try {
    return await Promise.race([
      readPages(url, brief, key, country, buyerType).catch((error) =>
        empty(error instanceof Error ? error.message : "Firecrawl read failed.")
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function startExtractJob(
  url: string,
  brief: Brief,
  key: string,
  country = "",
  buyerType = ""
): Promise<string> {
  const started = await requestJson("https://api.firecrawl.dev/v2/extract", {
    method: "POST",
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify(extractBody(url, brief, country, buyerType)),
  })
  const id = asString((started as { id?: unknown } | null)?.id)
  if (!id) throw new Error("Firecrawl extract did not return an id.")
  return id
}

export async function pollExtractJob(
  key: string,
  id: string,
  pageUrl: string
): Promise<{ pending: true } | { pending: false; extraction: Extraction }> {
  const latest = await requestJson(`https://api.firecrawl.dev/v2/extract/${id}`, {
    method: "GET",
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!extractSettled(latest)) return { pending: true }
  return { pending: false, extraction: extractionFromExtract(latest, pageUrl) }
}

export function timedOutExtraction(): Extraction {
  return empty(TIMEOUT_MESSAGE)
}
