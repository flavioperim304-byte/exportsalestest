import { mentionsCompany } from "./activity"
import type { Brief, CommerceKind, CommerceSignal, CommerceSnapshot, Lead } from "./types"
import { ApiError, requestJson } from "./http"
import { asString, clip, sameSite } from "./text"

export const COMMERCE_MONTHS = 24

export type { CommerceKind, CommerceSignal, CommerceSnapshot }

const KIND_LABEL: Record<CommerceKind, string> = {
  customs: "aduana / embarque",
  restock: "estoque / reposição",
  trade_fair: "feira",
  open_book: "abertura para marcas / fornecedores",
  hiring_buy: "vaga na área de compras",
}

const KIND_RANK: Record<CommerceKind, number> = {
  customs: 0,
  restock: 1,
  open_book: 2,
  trade_fair: 3,
  hiring_buy: 4,
}

// A customs term by itself (for example, HS code or NCM) is not evidence of a shipment.
const CUSTOMS_DOCUMENT =
  /\b(?:bill of lading|bl\s*\/\s*awb|manifiesto(?: de carga)?|manifesto de carga|customs (?:record|declaration|clearance|filing)|despacho aduanero|registro aduanero|registro de importaci[oó]n)\b/i
const CARGO =
  /\b(?:contenedor(?:es)?|containers?|embarque(?:s)?|shipment(?:s)?|cargo|carga|consignaci[oó]n|consignment)\b/i
const IMPORT_VERB =
  /\b(?:import[oó]|importamos|imported|importing|recibimos|recebemos|received|arrived|despach[oó]|cleared|shipped|embarc[oó]|embarcado|embarcamos)\b/i
const TARIFF_CODE = /\b(?:HS\s*[- ]?code|NCM)\b/i

const RESTOCK =
  /\b(?:restock(?:ed|ing)?|replenish(?:ed|ing)?|back in stock|in stock|out of stock|sold out|low stock|stock available|inventory available|reposi[cç][aã]o|reposici[oó]n|nuevo inventario|acaba de (?:llegar|chegar)|just (?:arrived|restocked)|ya (?:tenemos|hay) stock|sin stock|sem estoque|esgotado|agotado|chegou (?:estoque|stock))\b/i
const FAIR =
  /\b(?:cosmoprof|beautyworld|in-cosmetics|expocosmetica|trade fair|trade show|exhibitor|exposição|exposi[cç][aã]o|feira|feria (?:de|internacional|beauty)|stand (?:n[úu]mero|no\.?))\b/i
const OPEN_BOOK =
  /\b(?:seeking (?:suppliers|brands|new lines)|adding (?:brands|origins|lines)|open to (?:new )?(?:brands|suppliers)|looking for (?:suppliers|new brands)|new brand partnerships?|brand partnership|buscamos (?:marcas|proveedores)|buscando (?:marcas|fornecedores)|nuevas marcas|novas marcas|new suppliers|novos fornecedores|novos parceiros)\b/i
const BUY_ROLE =
  /\b(?:purchasing manager|procurement manager|import manager|import buyer|international buyer|buyer|gerente de compras|comprador(?:a)? internacional|responsable de compras|jefe de compras|encargado de compras)\b/i
const HIRING_CONTEXT =
  /\b(?:job opening|job vacancy|vacancy|we are hiring|now hiring|apply now|careers|career opportunity|recruiting|hiring|vaga|estamos contratando|se busca|vacante|oferta de empleo)\b/i

export function commerceKindLabel(kind: CommerceKind): string {
  return KIND_LABEL[kind]
}

export function commerceWindowStart(now = new Date()): string {
  const start = new Date(now)
  start.setMonth(start.getMonth() - COMMERCE_MONTHS)
  return start.toISOString()
}

/** Search for transaction/stock evidence. A result remains an indication until its parties, date and goods are checked. */
export function commerceBuyQuery(lead: Lead, brief: Brief): string {
  const market = lead.market || lead.country || brief.markets
  return [
    `"${lead.name}"`,
    market,
    '("bill of lading" OR "customs declaration" OR "import record" OR "import shipment" OR importer OR imported OR importó OR importación OR contenedor OR embarque OR shipment OR restock OR replenishment OR "back in stock" OR "out of stock" OR inventory OR reposición OR reposición)',
  ]
    .filter((part) => part.trim())
    .join(" ")
}

/** Search for commercial intent and market changes without treating generic activity as buying intent. */
export function commerceIntentQuery(lead: Lead, brief: Brief): string {
  const market = lead.market || lead.country || brief.markets
  return [
    `"${lead.name}"`,
    market,
    '("best seller" OR "top selling" OR "most sold" OR "sales growth" OR "sales increased" OR "units sold" OR "brand performance" OR "marca más vendida" OR "más vendido" OR ventas OR faturamento OR turnover OR "new brand" OR "new exclusive" OR "exclusive distribution" OR "dropped brand" OR "lost distribution" OR "looking for new brands" OR "seeking suppliers" OR "new supplier")',
  ]
    .filter((part) => part.trim())
    .join(" ")
}

/**
 * A customs signal requires transaction language, not just a tariff code or generic customs vocabulary.
 * This still identifies a public indication; it does not prove a purchase from the named supplier.
 */
export function isCustomsLanguage(blob: string): boolean {
  const hasDocument = CUSTOMS_DOCUMENT.test(blob)
  const hasCargoMovement = CARGO.test(blob) && IMPORT_VERB.test(blob)
  const hasTariffAndMovement = TARIFF_CODE.test(blob) && CARGO.test(blob) && IMPORT_VERB.test(blob)
  return (hasDocument && (CARGO.test(blob) || IMPORT_VERB.test(blob))) || hasCargoMovement || hasTariffAndMovement
}

export function classifyCommerce(url: string, title: string, text: string): CommerceKind | null {
  const blob = `${title} ${text} ${url}`
  if (isCustomsLanguage(blob)) return "customs"
  if (RESTOCK.test(blob)) return "restock"
  if (OPEN_BOOK.test(blob)) return "open_book"
  if (BUY_ROLE.test(blob) && HIRING_CONTEXT.test(blob)) return "hiring_buy"
  if (FAIR.test(blob)) return "trade_fair"
  return null
}

function isRecent(publishedAt: string | undefined, fetchedAt: string): boolean {
  // Undated or invalidly dated results are retained as references, but are not treated as recent.
  if (!publishedAt) return false
  const stamp = Date.parse(publishedAt)
  const fetched = Date.parse(fetchedAt)
  if (Number.isNaN(stamp) || Number.isNaN(fetched) || stamp > fetched) return false
  return fetched - stamp <= COMMERCE_MONTHS * 30 * 24 * 60 * 60 * 1000
}

export function signalsFromSearch(results: unknown[], lead: Lead): CommerceSignal[] {
  if (!Array.isArray(results)) return []
  const seen = new Set<string>()
  const signals: CommerceSignal[] = []

  for (const item of results) {
    const row = (item ?? {}) as Record<string, unknown>
    const url = asString(row.url)
    const title = asString(row.title)
    const highlights = Array.isArray(row.highlights)
      ? row.highlights.map((part) => asString(part)).filter(Boolean)
      : []
    const text = asString(row.text) || highlights[0] || ""
    const publishedAt = asString(row.publishedDate) || undefined

    if (!url || !title) continue
    if (!mentionsCompany(lead, title, url, text)) continue

    const kind = classifyCommerce(url, title, text)
    if (!kind) continue

    // A hiring/open-book statement on the candidate's own generic company page is not a dated signal.
    // Keep it only when the source is a distinct careers, vacancy or supplier-opportunity page.
    if ((kind === "hiring_buy" || kind === "open_book") && sameSite(url, lead.url)) {
      const pageContext = `${url} ${title}`
      const specificPage = /career|careers|job|jobs|vacan|supplier|vendor|partner|fornecedor|proveedor|apply/i.test(pageContext)
      if (!specificPage) continue
    }

    const key = `${kind}|${url.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    signals.push({
      kind,
      source: "exa",
      title,
      url,
      publishedAt,
      quote: clip(highlights[0] || text || title, 220),
    })
  }

  return signals
    .sort((left, right) => {
      const rank = KIND_RANK[left.kind] - KIND_RANK[right.kind]
      if (rank !== 0) return rank
      const leftParsed = left.publishedAt ? Date.parse(left.publishedAt) : Number.NaN
      const rightParsed = right.publishedAt ? Date.parse(right.publishedAt) : Number.NaN
      const leftDate = Number.isNaN(leftParsed) ? Number.NEGATIVE_INFINITY : leftParsed
      const rightDate = Number.isNaN(rightParsed) ? Number.NEGATIVE_INFINITY : rightParsed
      return rightDate - leftDate
    })
    .slice(0, 8)
}

export function recentCommerce(lead: Lead): CommerceSignal[] {
  const snapshot = lead.commerce
  if (!snapshot) return []
  return (snapshot.signals ?? []).filter((signal) => isRecent(signal.publishedAt, snapshot.fetchedAt))
}

export function hasCommerceSignals(lead: Lead): boolean {
  return recentCommerce(lead).length > 0
}

export function isTradeFilingSignal(signal: { kind: CommerceKind; source?: string }): boolean {
  return (
    signal.kind === "customs" &&
    (signal.source === "trade_record" || signal.source === "company_atlas")
  )
}

/** Only a dated, publicly published restock/availability statement is treated as a commercial buy fact. */
export function hasCommercialBuyFacts(lead: Lead): boolean {
  return recentCommerce(lead).some((signal) => signal.kind === "restock" && signal.source === "exa")
}

export function commerceLine(lead: Lead): string {
  if (!lead.commerce) return "Commercial signals have not been searched."
  if (lead.commerce.error && lead.commerce.signals.length === 0) {
    return `Commercial signal search failed. ${lead.commerce.error}`
  }

  const all = lead.commerce.signals ?? []
  const recent = recentCommerce(lead)
  if (recent.length === 0) {
    if (all.length > 0) {
      return `${all.length} commercial reference(s) were found, but none has a verifiable publication date within the last ${COMMERCE_MONTHS} months. Do not treat them as recent buying evidence.`
    }
    return `Exa found no attributable customs, stock/restock, supplier-opening, trade-fair, or purchasing-job signal in the last ${COMMERCE_MONTHS} months.`
  }

  const kinds = [...new Set(recent.map((signal) => commerceKindLabel(signal.kind)))].join(", ")
  const filing = recent.filter((signal) => isTradeFilingSignal(signal)).length
  const webCustoms = recent.filter((signal) => signal.kind === "customs" && !isTradeFilingSignal(signal)).length
  const notes: string[] = []
  if (filing) notes.push("Trade-record/Atlas entries are shipment indications; verify company role, date, goods and named parties.")
  if (webCustoms) notes.push("Exa customs results are web references, not independently verified customs records.")
  return `${recent.length} dated commercial signal(s) in the last ${COMMERCE_MONTHS} months: ${kinds}.${notes.length ? ` ${notes.join(" ")}` : ""}`
}

export function emptyCommerce(error?: string): CommerceSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    signals: [],
    error,
  }
}

async function searchOnce(query: string, key: string): Promise<unknown[]> {
  const data = await requestJson("https://api.exa.ai/search", {
    method: "POST",
    timeoutMs: 25000,
    headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 8,
      startPublishedDate: commerceWindowStart(),
      contents: {
        text: { maxCharacters: 600 },
        highlights: { maxHighlights: 2, maxCharacters: 220 },
      },
    }),
  })
  const results = (data as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) {
    throw new ApiError("Exa commercial search did not return results.", 502)
  }
  return results
}

export async function searchCommerce(lead: Lead, brief: Brief, key: string): Promise<CommerceSnapshot> {
  const queries = [commerceBuyQuery(lead, brief), commerceIntentQuery(lead, brief)]
  const settled = await Promise.allSettled(queries.map((query) => searchOnce(query, key)))
  const results: unknown[] = []
  const errors: string[] = []

  for (const item of settled) {
    if (item.status === "fulfilled") {
      results.push(...item.value)
    } else {
      const message = item.reason instanceof Error ? item.reason.message : "Exa commercial search failed."
      errors.push(message)
    }
  }

  const signals = signalsFromSearch(results, lead)
  if (signals.length === 0 && errors.length === queries.length) {
    return emptyCommerce(errors.join(" | "))
  }

  return {
    fetchedAt: new Date().toISOString(),
    signals,
    error: errors.length ? errors.join(" | ") : undefined,
  }
}
