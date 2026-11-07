import { activityLine } from "./activity"
import {
  anchorPromptMarkdown,
  briefUsesAnchorDistributors,
  firecrawlAnchorLine,
} from "./anchors"
import { buyingEvidenceLine, computeFitProbability, fitProbabilityLine } from "./fit-probability"
import { ragLine } from "./rag"
import type { Brief, Lead } from "./types"
import { clip, splitList } from "./text"

export const LEADS_PER_COUNTRY = 10

export function targetCountries(brief: Brief): string[] {
  return splitList(brief.markets)
}

function extra(brief: Brief): string {
  const note = brief.instructions?.trim()
  return note ? `Additional instructions: ${note}` : ""
}
/**
 * Hierarchy of pages to prioritize when crawling.
 * Added explicit preference for pages that state distribution/brand portfolios
 * over generic "about us" content — reduces noise in extraction.
 */
function firecrawlContactAsk(): string {
return [
"Crawl the company's official website, prioritizing pages with explicit distribution agreements, brand portfolios, product listings, or wholesale terms over generic 'about us' content. Include home, about, products, brands, distribution, wholesale, contact, team, and country-specific pages.",
"Search the web for the same company to corroborate its identity, country operations, commercial role, portfolio, and recent activity.",
"Collect only published business contacts: key person, role, email, WhatsApp, phone, and official website.",
"Leave unpublished fields empty. Never guess names, emails, addresses, phone numbers, or job titles.",
"Distinguish facts found on the official website from information found on third-party sources.",
].join(" ")
}

function exaBuyerSignalAsk(brief?: Brief): string {
return [
"Return a short buyerSignals field listing only concrete, published evidence of commercial role: specific brands distributed, named customer channels (wholesale/retail/salon), import or wholesale activity, or named customers.",
"Exclude generic company descriptions, trade fair participation, social media activity, hiring announcements, and mere brand mentions — these are not proof of import activity or willingness to buy.",
brief ? firecrawlAnchorLine(brief) : "",
]
.filter(Boolean)
.join(" ")
}
/**
 * Canonical evidence rule. Other sections reference this instead of repeating
 * the same 12 lines — reduces signal dilution in the prompt.
 */
export function evidenceRule(): string {
  return [
    "EVIDENCE RULE (mandatory): Never invent or turn an inference into a fact.",
    "Use published evidence from the candidate's own pages, cited URLs, page extracts, and explicitly supplied research material.",
    "Identify the source of each material claim. Prefer the company's official website for identity, products, brands, channels, and contact details.",
    "If a contact, import, purchase, sales volume, stock level, exclusivity, employee count, or intention to buy is not published, mark it unpublished or leave it empty.",
    "Do not fill gaps from training memory, typical distributors, similar companies, similar countries, or assumptions about what a company would normally do.",
    "Absence of public information is not proof that the activity does not exist.",
    "A company selling a product does not prove that it imports that product directly.",
    "A company mentioning a brand does not prove that it is the brand's official distributor.",
    "A trade shipment record does not prove that the company purchased a particular supplier's brand.",
    "Separate facts, indications, and interpretations.",
    "RAG similarity and system-generated scores are reference signals only. They are not company-specific proof of purchases, imports, contacts, brands, or commercial intent.",
    "A RAG neighbor is a different company. Never copy its contacts, brands, purchases, or commercial facts onto the candidate.",
  ].join(" ")
}

/** The salesperson wrote one prompt. The split buyer fields are empty. */
export function isPromptOnly(brief: Brief): boolean {
  const prompt = brief.instructions?.trim()
  if (!prompt) return false
  return ![
    brief.products,
    brief.buyerTypes,
    brief.mustHaves,
    brief.exclusions,
    brief.differentiators,
    brief.certifications,
  ].some((value) => value.trim())
}

function promptSearch(brief: Brief, country: string): string {
  return [
    brief.instructions?.trim() ?? "",
    `Search only for companies that operate commercially in ${country}. Verify the country from company pages or other reliable public evidence.`,
    `Identify the actual commercial role of each company. Do not assume that a company is an importer or distributor merely because it operates in the cosmetics or hair-care sector.`,
    `These are potential buyers for ${brief.supplierName}, from ${brief.originCountry}. Do not return ${brief.supplierName} itself or unrelated suppliers.`,
    "Do not broaden the requested buyer profile merely to fill the result list.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function competitorQuery(brief: Brief): string {
  const count = brief.countryCount && brief.countryCount > 0 ? brief.countryCount : 5
  const named = brief.markets.trim()
  const skip = brief.excludedMarkets?.trim()
  return [
    brief.instructions?.trim() || `Find distributors of ${brief.supplierName}.`,
    named ? `Only these countries: ${named}.` : `Cover ${count} countries.`,
    skip ? `Do not include these countries: ${skip}.` : "",
    `In each country, identify the company distributing ${brief.supplierName}, plus direct competitor distributors of rival brands in that same country.`,
    `A direct competitor distributor must have evidence of distributing or importing a rival brand in the searched country. A brand mention alone is insufficient.`,
    "Do not classify an ordinary retailer, salon, manufacturer, or logistics company as a distributor without supporting evidence.",
    "Do not return the brand's own headquarters as a local distributor.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function competitorSystemPrompt(): string {
  return [
    evidenceRule(),
    "You are in company discovery mode.",
    "Return real companies and their official websites.",
    "For every requested country, identify the named brand's local distributor and direct competitor distributors of rival brands.",
    "Confirm the commercial role from public evidence. Do not assume distribution from a brand mention or product listing alone.",
    "A retailer, salon, manufacturer, or logistics company is not automatically a distributor.",
    "Do not include companies in excluded countries.",
    "Do not score companies and do not invent email addresses, phone numbers, brands, or distribution relationships.",
  ].join(" ")
}

export function buyerTypes(brief: Brief): string[] {
  return splitList(brief.buyerTypes)
}

/**
 * Discovery query tightened: requires published portfolio/brands/listings,
 * not just "handles products related to". Separates discovery from qualification.
 */
export function exaQuery(brief: Brief, country: string, buyerType?: string): string {
  if (isPromptOnly(brief)) return promptSearch(brief, country)
  const type =
    buyerType?.trim() ||
    brief.buyerTypes.trim() ||
    "importer, distributor, or wholesaler"
  return [
    `Find ${type} companies with an official website, operating commercially in ${country}, whose published portfolio, brands, or product listings include ${brief.products} or directly competing categories.`,
    `The company must show evidence of the requested commercial role. Do not return a company simply because it belongs to the cosmetics or hair-care sector.`,
    `This search is for this buyer type: ${type}. Do not replace it with a different buyer type to complete the list.`,
    `Potential buyers for ${brief.supplierName}, from ${brief.originCountry}. Do not return ${brief.supplierName} itself or unrelated suppliers.`,
    brief.mustHaves
      ? `Prioritize companies with published evidence of: ${brief.mustHaves}.`
      : "",
    brief.exclusions
      ? `Exclude companies matching these conditions: ${brief.exclusions}.`
      : "",
    brief.certifications
      ? `Relevant certifications, when published: ${brief.certifications}. Do not assume certification.`
      : "",
    brief.differentiators
      ? `Supplier offer and relevant product characteristics: ${brief.differentiators}. Use these to assess category relevance, not to assume buying intent.`
      : "",
    "Verify company identity and commercial activity in the searched country.",
    "Do not require published import records as a condition for discovery. A qualified wholesaler or distributor may buy locally.",
    "Do not treat trade fair participation, social media activity, hiring, or a brand mention as proof of import activity or purchase intent.",
    exaBuyerSignalAsk(brief),
    extra(brief),
  ]
    .filter(Boolean)
    .join(" ")
}

export function exaBackupQuery(brief: Brief, country: string, buyerType?: string): string {
  if (isPromptOnly(brief)) return promptSearch(brief, country)
  const type =
    buyerType?.trim() ||
    brief.buyerTypes.trim() ||
    "importer, distributor, or wholesaler"
  return [
    `Find additional ${type} companies with an official website, operating commercially in ${country}, whose published portfolio, brands, or product listings include ${brief.products} or directly competing categories.`,
    "Find companies not already identified in the first search. Do not return duplicates under alternative trade names when they share the same company identity or official domain.",
    `Keep the same buyer type: ${type}. Do not broaden the search to unrelated buyer categories.`,
    `Potential buyers for ${brief.supplierName}. Do not return ${brief.supplierName} itself or unrelated suppliers.`,
    brief.mustHaves ? `Prioritize evidence of: ${brief.mustHaves}.` : "",
    brief.exclusions ? `Exclude: ${brief.exclusions}.` : "",
    "Do not require public import records as a condition for discovery.",
    "Do not treat brand mentions, fair participation, social activity, or hiring as proof of purchase intent.",
    extra(brief),
    exaBuyerSignalAsk(brief),
  ]
    .filter(Boolean)
    .join(" ")
}

export function dumpConfirmQueryLine(brief: Brief, country: string): string {
  return [
    evidenceRule(),
    `Confirm whether each named company in ${country} exists and whether public evidence supports its role as a ${brief.products || "hair-care"} importer, distributor, wholesaler, or other relevant buyer type.`,
    "Exa looks up each company name. Firecrawl then crawls the official site and corroborating web sources.",
    "A trade dump is a discovery signal, not proof of a purchase from the named supplier or proof of current commercial activity.",
    "Distinguish direct imports from local purchasing, exports, logistics activity, and unrelated shipments.",
    "Do not reject a company solely because its import activity is not publicly visible.",
    extra(brief),
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * firecrawlPrompt refactored: extracted a shared base, then appended deltas per searchKind.
 * Reduces duplication and keeps critical instructions in one place.
 */
function firecrawlBasePrompt(
  brief: Brief,
  country: string,
  buyerType: string | undefined,
  kindLabel: string
): string[] {
  return [
    evidenceRule(),
    firecrawlContactAsk(),
    `Supplier: ${brief.supplierName} (${brief.originCountry}).`,
    country
      ? `This company was retrieved as a candidate for ${country} (${kindLabel}). Verify its identity and commercial activity in that market.`
      : `Target markets: ${brief.markets}.`,
    buyerType
      ? `The initial search labeled this company as: ${buyerType}. Verify this label from the company's actual activities; do not assume it is correct.`
      : "",
    "Determine the company's actual business role, products, brands, and channels before judging compatibility.",
    extra(brief),
  ].filter(Boolean)
}

export function firecrawlPrompt(
  brief: Brief,
  country: string,
  buyerType?: string
): string {
  // Normalized searchKind (trimmed) — see note at top of file about searchKind hygiene.
  const kind = (brief.searchKind ?? "").trim()

  if (kind === "dump") {
    return [
      ...firecrawlBasePrompt(brief, country, buyerType, "trade-data dump"),
      `Products context: ${brief.products || "hair-care"}.`,
      "Determine whether the company is an importer, distributor, wholesaler, retailer, manufacturer, salon, logistics provider, or another type of business.",
      "Confirm whether it operates in hair care, shampoo, cosmetics, or the categories relevant to the brief.",
      "A shipment record alone does not prove that the company buys the supplier's brand or currently distributes it.",
      "Reject logistics providers, freight forwarders, and unrelated companies when they do not meet the buyer profile.",
      "Do not automatically reject a retailer or salon if the brief explicitly includes that buyer type and the company shows the relevant commercial activity.",
      brief.instructions?.trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (kind === "competitors") {
    return [
      ...firecrawlBasePrompt(brief, country, buyerType, "competitor mapping"),
      `Brand to map: ${brief.supplierName} (${brief.originCountry}).`,
      "Confirm whether the company distributes the named brand or a rival brand in the searched country.",
      "A brand mention, isolated product listing, or social media reference is not sufficient by itself to establish official distribution.",
      "Identify the source supporting the distribution relationship and the country where it applies.",
      brief.instructions?.trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (isPromptOnly(brief)) {
    return [
      evidenceRule(),
      firecrawlContactAsk(),
      `Supplier: ${brief.supplierName} (${brief.originCountry}).`,
      country
        ? `This company was retrieved as a candidate for ${country}.`
        : `Target markets: ${brief.markets}.`,
      "First identify the company's actual business role, products, brands, and channels.",
      "Then judge the company only against the following search prompt:",
      brief.instructions?.trim() ?? "",
      "Do not introduce additional buyer requirements that are not present in the search prompt.",
    ]
      .filter(Boolean)
      .join("\n")
  }

  // Default: buyers
  const type = buyerType?.trim()
  return [
    ...firecrawlBasePrompt(brief, country, buyerType, "buyer discovery"),
    `Products: ${brief.products}.`,
    brief.buyerTypes ? `Buyer types allowed by this brief: ${brief.buyerTypes}.` : "",
    brief.mustHaves ? `Check for published evidence of these requirements: ${brief.mustHaves}.` : "",
    brief.exclusions ? `Check whether the company matches any of these exclusions: ${brief.exclusions}.` : "",
    brief.certifications
      ? `Relevant certifications: ${brief.certifications}. Record only certifications actually found.`
      : "",
    brief.differentiators
      ? `Supplier differentiators: ${brief.differentiators}. Assess relevance without assuming the company wants to buy.`
      : "",
    "Record the company's role, products it buys, products it sells, brands in its portfolio, customer channels, and evidence of wholesale, distribution, or import activity separately.",
    "Do not classify a company as an importer solely because it sells imported products.",
    "Do not classify a company as a distributor solely because it lists several brands.",
    "Do not reject a potentially relevant company solely because import records or purchasing data are unpublished.",
  ]
    .filter(Boolean)
    .join("\n")
}

/**
 * Shared discovery brief for combined searches.
 * Explicitly separates the two suppliers so the model does not read them as one entity.
 */
export function searchBrief
