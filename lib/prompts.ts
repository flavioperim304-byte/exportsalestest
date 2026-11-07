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

function firecrawlContactAsk(): string {
  return [
    "Crawl the company's official website, prioritizing home, about, products, brands, distribution, wholesale, contact, team, and relevant country pages.",
    "Search the web for the same company to corroborate its identity, country operations, commercial role, portfolio, and recent activity.",
    "Collect only published business contacts: key person, role, email, WhatsApp, phone, and official website.",
    "Leave unpublished fields empty. Never guess names, emails, addresses, phone numbers, or job titles.",
    "Distinguish facts found on the official website from information found on third-party sources.",
  ].join(" ")
}

function exaBuyerSignalAsk(brief?: Brief): string {
  return [
    "Return short buyerSignals based on published evidence of the company's actual commercial role, products, brands, customers, channels, wholesale activity, distribution, or imports.",
    "Do not treat a generic company description, trade fair participation, social media activity, or a brand mention as proof of import activity or willingness to buy.",
    brief ? firecrawlAnchorLine(brief) : "",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Shared evidence rules. Missing information must remain missing, not become a negative fact. */
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

export function exaQuery(brief: Brief, country: string, buyerType?: string): string {
  if (isPromptOnly(brief)) return promptSearch(brief, country)

  const type =
    buyerType?.trim() ||
    brief.buyerTypes.trim() ||
    "importer, distributor, or wholesaler"

  return [
    `Find ${type} companies operating commercially in ${country} that handle products or categories related to ${brief.products}.`,
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
    `Find additional ${type} companies operating commercially in ${country} that handle products or categories related to ${brief.products}.`,
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

export function firecrawlPrompt(
  brief: Brief,
  country: string,
  buyerType?: string
): string {
  if (brief.searchKind === "dump") {
    return [
      evidenceRule(),
      firecrawlContactAsk(),
      `Supplier: ${brief.supplierName} (${brief.originCountry}).`,
      country
        ? `This company name came from a trade-data search associated with ${country}. Verify its identity and commercial activity in that market.`
        : "This company name came from a trade-data search. Verify its identity and commercial activity from public sources.",
      "Determine whether the company is an importer, distributor, wholesaler, retailer, manufacturer, salon, logistics provider, or another type of business.",
      "Confirm whether it operates in hair care, shampoo, cosmetics, or the categories relevant to the brief.",
      "A shipment record alone does not prove that the company buys the supplier's brand or currently distributes it.",
      "Reject logistics providers, freight forwarders, and unrelated companies when they do not meet the buyer profile.",
      "Do not automatically reject a retailer or salon if the brief explicitly includes that buyer type and the company shows the relevant commercial activity.",
      buyerType ? `The initial search labeled this company as: ${buyerType}. Verify this label; do not assume it is correct.` : "",
      brief.instructions?.trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n")
  }

  if (brief.searchKind === "competitors") {
    return [
      evidenceRule(),
      firecrawlContactAsk(),
      `Brand: ${brief.supplierName} (${brief.originCountry}).`,
      country
        ? `This company was retrieved in ${country}.`
        : "Determine the relevant country from published evidence.",
      buyerType
        ? `The initial search labeled this company as: ${buyerType}. Verify this classification.`
        : "",
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
    ].join("\n")
  }

  const type = buyerType?.trim()

  return [
    evidenceRule(),
    firecrawlContactAsk(),
    `Supplier: ${brief.supplierName} (${brief.originCountry}). Products: ${brief.products}.`,
    country
      ? `This company was retrieved as a candidate for ${country}.`
      : `Target markets: ${brief.markets}.`,
    type
      ? `Initial buyer-type classification: ${type}. Verify the classification from the company's actual activities.`
      : "",
    brief.buyerTypes
      ? `Buyer types allowed by this brief: ${brief.buyerTypes}.`
      : "",
    brief.mustHaves
      ? `Check for published evidence of these requirements: ${brief.mustHaves}.`
      : "",
    brief.exclusions
      ? `Check whether the company matches any of these exclusions: ${brief.exclusions}.`
      : "",
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
    extra(brief),
  ]
    .filter(Boolean)
    .join(" ")
}

/**
 * Shared discovery brief for combined searches.
 * It defines the union of companies to discover, not a shared final supplier score.
 * Final supplier compatibility must be assessed separately for each brief.
 */
export function searchBrief(brief: Brief, also?: Brief): Brief {
  if (!also) return brief

  return {
    ...brief,
    supplierName: `${brief.supplierName} and ${also.supplierName}`,
    products: `${brief.products}. Also ${also.products}`,
    buyerTypes: `${brief.buyerTypes}. Also ${also.buyerTypes}`,
    mustHaves: [brief.mustHaves, also.mustHaves].filter(Boolean).join(". "),
    differentiators: [brief.differentiators, also.differentiators]
      .filter(Boolean)
      .join(" "),
    exclusions: [brief.exclusions, also.exclusions]
      .filter(Boolean)
      .join(", "),
    instructions: [brief.instructions, also.instructions]
      .filter(Boolean)
      .join(" "),
  }
}

export function exaSystemPrompt(brief?: Brief): string {
  return [
    evidenceRule(),
    "You are in company discovery mode, not scoring mode.",
    `Return at most ${LEADS_PER_COUNTRY} real companies of the buyer type specified in the query.`,
    "Every company must operate commercially in the one country named in the query. Do not include companies merely because they have a regional website or mention that country.",
    "Return potential buyers for the supplier named in the query. Do not return that supplier itself or unrelated suppliers.",
    "Each company must have an official website or a clearly identified official business presence.",
    "Prioritize evidence of the actual commercial role, relevant products, brands, and sales channels.",
    "Do not substitute salons, retailers, manufacturers, or service providers for the requested buyer type.",
    "Do not require public import records if the company otherwise meets the requested buyer profile.",
    "Do not score companies, produce a market report, or invent email addresses, phone numbers, import activity, or purchase intent.",
    "Avoid duplicate companies under different trading names when the identity or official domain is the same.",
    exaBuyerSignalAsk(brief),
    "Prefer official company websites over social profiles. Use social profiles only as supporting evidence when relevant.",
  ]
    .filter(Boolean)
    .join(" ")
}

function openaiEvidenceSection(brief: Brief, also?: Brief): string {
  const sites = [brief.website, also?.website].filter(Boolean)

  return [
    "### EVIDENCE AND FACT-CHECKING RULES",
    "Use only evidence contained in the candidate cards and their cited URLs or page extracts. Do not browse.",
    "Do not invent company identity, country, contacts, products, brands, imports, purchases, volumes, stock, sales, exclusivity, or intent to buy.",
    "Separate verified facts from indications and interpretations.",
    "Absence of published information is unknown, not proof that the activity does not exist.",
    "A company's products for sale are not automatically products it imports directly or purchases from the named supplier.",
    "A brand mention does not automatically establish an official distribution relationship.",
    "Hiring, social media activity, trade fair participation, and generic company growth are not proof of purchase intent.",
    "Do not treat system-generated fit scores, buying-evidence summaries, RAG similarity, or preliminary classifications as independent evidence.",
    "Do not copy contacts, brands, purchases, or commercial facts from a RAG neighbor or another company.",
    "Do not add requirements, must-haves, or exclusions that are not stated in the brief.",
    sites.length ? `The supplier's own website is not a buyer: ${sites.join(" or ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function openaiScopeSection(
  brief: Brief,
  also: Brief | undefined,
  kind: "buyers" | "prompt" | "competitors" | "dump"
): string {
  const countries = targetCountries(brief)
  const markets = countries.length
    ? countries.join(", ")
    : brief.markets || "unpublished"

  const suppliers = also
    ? `${brief.supplierName} and ${also.supplierName}`
    : brief.supplierName

  const lines = [
    "### SEARCH SCOPE AND COMMERCIAL CRITERIA",
    `- **Supplier(s):** ${suppliers}, from ${brief.originCountry || "unpublished"}.`,
    `- **Target markets:** ${markets}.`,
  ]

  if (kind === "competitors") {
    lines.push(
      `- **Brand to map:** ${brief.supplierName}.`,
      brief.excludedMarkets
        ? `- **Excluded countries:** ${brief.excludedMarkets}.`
        : "",
      "- **Target profile:** the brand's local distributor and direct competitor distributors of rival brands in each searched country.",
      "- A retailer, salon, manufacturer, or brand mention is not automatically proof of distributor status."
    )
  } else if (kind === "prompt") {
    lines.push(
      "- Evaluate the candidate only against the search prompt in <search_prompt>.",
      "- Identify the company's actual commercial role before assessing compatibility.",
      "- Extract contacts, brands, launches, hiring, and web mentions only when published."
    )
  } else {
    lines.push(
      `- **${brief.supplierName} products:** ${brief.products || "unpublished"}.`,
      `- **Buyer types:** ${brief.buyerTypes || "unpublished"}. A candidate may match any buyer type explicitly allowed by the brief.`,
      `- **Must-haves:** ${brief.mustHaves || "none stated"}.`,
      `- **Exclusions:** ${brief.exclusions || "none stated"}.`,
      `- **Certifications:** ${brief.certifications || "none stated"}.`,
      "- Do not require public import records if the company otherwise meets the buyer profile.",
      "- Distinguish a company's buying activity from its selling activity."
    )

    if (also) {
      lines.push(
        `- **${also.supplierName} products:** ${also.products || "unpublished"}.`,
        `- **${also.supplierName} buyer types:** ${also.buyerTypes || "unpublished"}.`,
        `- **${also.supplierName} must-haves:** ${also.mustHaves || "none stated"}.`,
        `- **${also.supplierName} exclusions:** ${also.exclusions || "none stated"}.`,
        "- Evaluate compatibility with each supplier independently. Do not copy one supplier's fit rating to the other."
      )
    }

    lines.push(
      "- **Required metadata, only when published:** company role, country, key contact, email, WhatsApp, phone, brands in portfolio, products bought, products sold, customer channels, recent launches, and relevant recent activity."
    )
  }

  if (kind === "dump") {
    lines.push(
      "- Trade-dump records are discovery signals, not proof of purchase from the named supplier.",
      "- A shipment may support the conclusion that the company moves cargo, but does not by itself establish its current portfolio, distribution role, or supplier relationship.",
      "- Do not copy shipment volume into last purchase or sales fields.",
      "- Assess company identity, buyer role, and supplier compatibility separately."
    )
  }

  const extraNote = [
    brief.instructions?.trim(),
    also?.instructions?.trim(),
  ]
    .filter(Boolean)
    .join("\n")

  if (extraNote) {
    lines.push("", "<search_prompt>", extraNote, "</search_prompt>")
  }

  return lines.filter(Boolean).join("\n")
}

function openaiScoringSection(
  kind: "buyers" | "prompt" | "competitors" | "dump"
): string {
  if (kind === "competitors") {
    return [
      "### CLASSIFICATION RULES",
      "",
      "| Field | Values | Meaning and rules |",
      "| --- | --- | --- |",
      "| `icp` | `high` | `medium` | `low` |",
      "| `best_fit` | brand name | `direct competitor` | `neither` | `unknown` |",
      "| `purchase_probability` | `high` | `medium` | `low` |",
      "| `qualification_needed` | string | State what still needs verification. |",
      "| `entry_strategy` | string | Concise market-entry recommendation supported by the available evidence. |",
      "",
      "For competitor mapping, classify the actual distribution relationship in the searched country. Do not use unpublished last purchase, stock, or sales data as a reason to set best_fit to neither.",
      "Use unknown when the available evidence cannot establish whether the company distributes the named brand or a rival brand.",
      "The purchase_probability field is a qualitative evidence tier only, not a statistical probability. Do not output percentages.",
    ].join("\n")
  }

  return [
    "### CLASSIFICATION RULES",
    "",
    "#### 1. ICP (`high` | `medium` | `low`)",
    "- Assess the candidate's compatibility with the buyer profile in the brief.",
    "- Consider company role, category, product portfolio, customer channels, and evidence of commercial operation.",
    "- High means strong alignment with the requested buyer profile. It does not mean that the company intends to buy.",
    "- Medium means partial alignment or relevant potential with some important facts still unverified.",
    "- Low means evidence of material mismatch with the requested buyer profile. Missing information alone is not enough to assign low.",
    "",
    "#### 2. Supplier fit (`supplier_fits`)",
    "- Evaluate each supplier separately against that supplier's products, buyer profile, must-haves, exclusions, and differentiators.",
    "- Do not copy the same fit level to both suppliers unless the evidence independently supports the same conclusion.",
    "- A company can have high ICP for the general buyer profile but different fit levels for the individual suppliers.",
    "- Do not require published purchase history to establish product or channel compatibility.",
    "",
    "#### 3. Best fit (`best_fit`)",
    "- Use only the supplier name, `both`, `neither`, or `unknown`.",
    "- Use a supplier name when the evidence shows that supplier is the better commercial match.",
    "- Use `both` when both suppliers have independently supported commercial compatibility.",
    "- Use `neither` only when evidence indicates that neither supplier is suitable.",
    "- Use `unknown` when there is insufficient evidence to compare the suppliers.",
    "- Do not set `neither` merely because last purchase, stock, import volume, or sales figures are unpublished.",
    "- Do not infer best_fit from a preliminary score, RAG similarity, hiring, social activity, or a brochure alone.",
    "",
    "#### 4. Purchase evidence (`purchase_probability`)",
    "- This field is a temporary qualitative evidence tier, NOT a statistical probability of purchase or response.",
    "- `high` requires direct and recent evidence of an active commercial opportunity, such as a request for prices, catalog, samples, a meeting, a concrete negotiation, or a confirmed discussion about adding a brand.",
    "- `medium` means the company is commercially compatible, but there is no direct evidence of an active opportunity.",
    "- `low` means there is evidence of commercial mismatch or a reason the opportunity is unlikely. Missing data alone is not sufficient.",
    "- Do not output percentages or describe the field as a calibrated probability.",
    "",
    "#### 5. Qualification (`qualification_needed`)",
    "- State the specific facts that a salesperson still needs to confirm.",
    "- Examples: whether the company imports directly, who makes purchasing decisions, whether it accepts new brands, which channels it serves, and its relevant category volumes.",
    "- Do not present an unpublished fact as a negative finding.",
    "",
    "#### 6. Rationale and entry strategy",
    "- Explain the classification using concrete candidate-specific evidence.",
    "- Separate verified facts from interpretations.",
    "- Do not invent market statistics, company volumes, commercial practices, or purchase history.",
  ].join("\n")
}

export function openaiInstructions(brief: Brief, also?: Brief): string {
  const kind: "buyers" | "prompt" | "competitors" | "dump" =
    brief.searchKind === "competitors" && !also
      ? "competitors"
      : brief.searchKind === "dump"
        ? "dump"
        : isPromptOnly(brief) && !also
          ? "prompt"
          : "buyers"

  const suppliers = also
    ? `${brief.supplierName} and ${also.supplierName}`
    : brief.supplierName

  const role =
    kind === "competitors"
      ? `You are a B2B company verification analyst mapping local distributors of ${brief.supplierName} from ${brief.originCountry}. Evaluate only the supplied candidate cards. Do not browse or invent companies, brands, or countries.`
      : `You are a B2B export lead qualification analyst evaluating candidates for ${suppliers} from ${brief.originCountry}. Assess identity, commercial role, ICP compatibility, individual supplier fit, and evidence of an active opportunity. Do not browse.`

  const markets =
    targetCountries(brief).join(", ") ||
    brief.markets ||
    "the search country"

  return [
    "# ROLE AND TASK",
    role,
    "",
    openaiEvidenceSection(brief, also),
    "",
    openaiScopeSection(brief, also, kind),
    "",
    briefUsesAnchorDistributors(brief)
      ? `${anchorPromptMarkdown(markets)}\n\n`
      : "",
    openaiScoringSection(kind),
    "",
    "### EVALUATION PROCESS",
    "For each candidate card:",
    "1. Verify the company's identity and country using the supplied evidence.",
    "2. Identify its actual commercial role. Do not infer importer or distributor status from sector membership alone.",
    "3. Assess its general ICP compatibility against the brief.",
    "4. Assess supplier_fits independently for each named supplier.",
    "5. Determine best_fit using the controlled values and rules above.",
    "6. Evaluate evidence of an active commercial opportunity separately from ICP and supplier compatibility.",
    "7. List specific qualification gaps. Do not turn missing information into negative facts.",
    "8. Write a concise rationale based on candidate-specific evidence.",
    "",
    "### INPUT",
    "Candidate cards arrive in the user message inside <candidate_cards>. Evaluate only those candidates.",
    "",
    "### OUTPUT CONTRACT",
    "Preserve the existing JSON output fields and their names.",
    "The output must contain leads, purchase_probability, purchase_probability_note, and entry_strategy.",
    "Each lead must contain company, icp, rationale, supplier_fits, best_fit, and qualification_needed.",
    "Do not add fields or change the output structure.",
    "",
    "```output_schema",
    '{ "leads": [{ "company": "", "icp": "high|medium|low", "rationale": "", "supplier_fits": [{ "supplier": "", "level": "high|medium|low" }], "best_fit": "", "qualification_needed": "" }], "purchase_probability": "high|medium|low", "purchase_probability_note": "", "entry_strategy": "" }',
    "```",
  ]
    .filter(Boolean)
    .join("\n")
}

function parallelKind(
  brief: Brief,
  also?: Brief
): "buyers" | "prompt" | "competitors" | "dump" {
  if (brief.searchKind === "competitors" && !also) return "competitors"
  if (brief.searchKind === "dump") return "dump"
  if (isPromptOnly(brief) && !also) return "prompt"
  return "buyers"
}

function parallelEvidenceSection(brief: Brief, also?: Brief): string {
  const sites = [brief.website, also?.website].filter(Boolean)

  return [
    "### INDEPENDENT EVIDENCE VERIFICATION",
    "Perform a focused verification of the supplied candidate companies. Do not repeat broad market discovery.",
    "Use current, publicly accessible sources to verify the exact company identity, official website, country operations, commercial role, products, brands, and channels.",
    "Separate facts, indications, interpretations, and unknowns.",
    "Absence of public import or purchase data is not proof that the company does not import or buy.",
    "A shipment record does not prove a purchase from the named supplier.",
    "A brand mention does not automatically prove official distribution.",
    "Hiring, social activity, and trade fair participation do not prove purchase intent.",
    "Do not copy facts from another company, a RAG neighbor, or an anchor profile.",
    "OpenAI's preliminary classifications are hypotheses to verify, not facts. Change them only when evidence supports the change, and explain why.",
    "Cite the exact URL for each material claim or classification change.",
    "Do not invent contacts, volumes, sales, stock, import history, exclusivity, or response rates.",
    sites.length
      ? `Do not treat the supplier's own website as a buyer: ${sites.join(" or ")}.`
      : "",
  ]
    .filter(Boolean)
    .join("\n")
}

function parallelScoringSection(
  kind: "buyers" | "prompt" | "competitors" | "dump"
): string {
  if (kind === "competitors") {
    return [
      "### VALIDATION CRITERIA",
      "- Confirm whether the company distributes the named brand or a rival brand in the searched country.",
      "- `icp` is high only when the relevant distribution role is supported by evidence; medium when plausible but not fully verified; low when evidence shows the company is unrelated.",
      "- `best_fit` identifies the named brand, `direct competitor`, `neither`, or `unknown` according to the evidence.",
      "- Do not use unpublished last purchase, stock, or sales data as a reason to assign neither.",
      "- `purchase_probability` is a qualitative evidence tier, not a statistical probability.",
    ].join("\n")
  }

  return [
    "### VALIDATION CRITERIA",
    "",
    "#### 1. Identity and commercial role",
    "- Verify that the candidate is the correct company and operates in the searched country.",
    "- Determine whether it is an importer, distributor, wholesaler, retailer, salon, manufacturer, or another business type.",
    "- Do not infer a role from the company's name or sector alone.",
    "",
    "#### 2. ICP and channel compatibility",
    "- Apply the same ICP definitions used by OpenAI.",
    "- Assess the buyer type specified in the brief and the company's actual products and channels.",
    "- A wholesaler or trading company is not automatically less suitable than a distributor if it meets the brief.",
    "- Missing import data alone must not lower a company's ICP.",
    "",
    "#### 3. Individual supplier fit",
    "- Assess each supplier separately against its own products, channels, must-haves, and exclusions.",
    "- Do not copy the same supplier fit from one supplier to another.",
    "- Do not use general ICP as a substitute for individual supplier fit.",
    "",
    "#### 4. Best fit",
    "- Use the same controlled values and definitions as OpenAI: supplier name, `both`, `neither`, or `unknown`.",
    "- `neither` requires evidence of incompatibility with both suppliers.",
    "- Use `unknown` when the available evidence does not permit a reliable comparison.",
    "",
    "#### 5. Active commercial opportunity",
    "- Separate commercial compatibility from evidence of an active opportunity.",
    "- Direct evidence includes requests for prices, catalog, samples, meetings, negotiations, or explicit discussions about adding a brand.",
    "- Social activity, hiring, fair participation, and general market growth are not direct opportunity evidence.",
    "- Do not interpret model confidence as purchase or response probability.",
    "",
    "#### 6. Audit trail",
    "- State what was confirmed, what was contradicted, and what remains unknown.",
    "- Explain any change to OpenAI's preliminary ICP, supplier fit, or best_fit with the supporting URL.",
    "- Do not change a classification merely because a source did not publish the relevant information.",
  ].join("\n")
}

export function parallelInstructions(brief: Brief, also?: Brief): string {
  const kind = parallelKind(brief, also)
  const countries = targetCountries(brief)

  const suppliers = also
    ? `${brief.supplierName} and ${also.supplierName}`
    : brief.supplierName

  const markets =
    countries.length
      ? countries.join(", ")
      : brief.markets || "unpublished"

  const count =
    brief.countryCount && brief.countryCount > 0
      ? brief.countryCount
      : 5

  const role =
    kind === "competitors"
      ? `You are an independent verification analyst checking local distributors of ${brief.supplierName} from ${brief.originCountry} and their direct competitors.`
      : `You are an independent B2B lead verification analyst reviewing candidates for ${suppliers} from ${brief.originCountry}. Your task is to verify evidence and stress-test preliminary classifications, not to repeat broad market discovery.`

  const outlook =
    kind === "competitors"
      ? countries.length
        ? `Check only these countries: ${markets}.`
        : `Cover ${count} countries.`
      : countries.length
        ? `The target markets are: ${markets}. Verify only the supplied candidates in these markets.`
        : `Target markets: ${markets}.`

  return [
    "# ROLE AND MISSION",
    role,
    "",
    parallelEvidenceSection(brief, also),
    "",
    openaiScopeSection(brief, also, kind),
    `- **Market scope:** ${outlook}`,
    kind === "competitors" && brief.excludedMarkets
      ? `- **Excluded countries:** ${brief.excludedMarkets}.`
      : "",
    "",
    briefUsesAnchorDistributors(brief)
      ? `${anchorPromptMarkdown(markets)}\n\n`
      : "",
    parallelScoringSection(kind),
    "",
    "### EXECUTION WORKFLOW",
    "For each supplied candidate:",
    "1. Verify the exact company identity, official website, and country operations.",
    "2. Confirm the company's actual commercial role.",
    "3. Verify relevant products, brands, and customer channels.",
    "4. Assess whether the evidence supports the preliminary ICP.",
    "5. Assess each supplier fit independently.",
    "6. Confirm, revise, or mark best_fit as unknown according to the shared criteria.",
    "7. Look for direct evidence of openness to new brands or an active commercial opportunity, when available.",
    "8. Identify contradictions, outdated information, and qualification gaps.",
    "9. Cite the source URLs supporting material findings and any changes.",
    "",
    "### RESEARCH LIMITS",
    "Do not conduct a broad market report or repeat the original candidate discovery.",
    "Do not create a new candidate list unless the requested task explicitly requires competitor mapping.",
    "Do not produce unsupported market statistics or lengthy generic entry strategies.",
    "Do not treat system scores, model confidence, or preliminary classifications as evidence.",
    "",
    "### INPUT",
    "The supplied candidate cards contain the companies to verify and may contain preliminary OpenAI classifications.",
    "Research only those companies for lead validation.",
  ]
    .filter(Boolean)
    .join("\n")
}

function competitorMarketRule(brief: Brief, countries: string[]): string {
  const markets = countries.length
    ? countries.join(", ")
    : "the search countries"

  const origin =
    brief.originCountry.trim() || "the supplier origin country"

  return [
    `- Competitors must already sell the relevant category in ${markets}.`,
    `- Do not list factories, exporters, or brands that only sell in ${origin}.`,
    "- For each competitor, country means the search market where the company sells, not its headquarters.",
    `- A brand from ${origin} belongs on the list only when a source shows it selling in a search country; country must then be that search country.`,
    "- Do not infer a competitor's local distribution from its global presence alone.",
  ].join("\n")
}

export function researchPrompt(
  brief: Brief,
  leads: Lead[],
  also?: Brief
): string {
  const suppliers = also
    ? `${brief.supplierName} and ${also.supplierName}`
    : brief.supplierName

  const cards = leads
    .map((lead, index) => {
      const extraction = lead.extraction

      const lines = [
        `<candidate index="${index + 1}">`,
        `- **Name:** ${lead.name}`,
        lead.market ? `- **Market:** searched for ${lead.market}` : "",
        lead.buyerType ? `- **Buyer type:** searched as ${lead.buyerType}` : "",
        `- **URL:** ${lead.url}`,
        `- **Country:** ${extraction?.country || lead.country || "unpublished"}`,
        extraction?.role ? `- **Role:** ${extraction.role}` : "",
        extraction?.buys?.length
          ? `- **Buys:** ${extraction.buys.slice(0, 4).join("; ")}`
          : "",
        extraction?.sells?.length
          ? `- **Sells:** ${extraction.sells.slice(0, 4).join("; ")}`
          : "",
        extraction?.keyPerson
          ? `- **Key person:** ${extraction.keyPerson}${extraction.keyPersonRole ? ` (${extraction.keyPersonRole})` : ""}`
          : "",
        extraction?.email ? `- **Email:** ${extraction.email}` : "",
        extraction?.phone ? `- **Phone:** ${extraction.phone}` : "",
        extraction?.whatsapp ? `- **WhatsApp:** ${extraction.whatsapp}` : "",
        extraction?.latestHires?.length
          ? `- **Latest hires:** ${extraction.latestHires.slice(0, 3).join("; ")}`
          : "",
        lead.openai
          ? `- **OpenAI preliminary:** icp ${lead.openai.icp}; best_fit ${lead.openai.bestFit}. ${clip(lead.openai.rationale, 180)}`
          : "- **OpenAI preliminary:** unscored.",
        activityLine(lead)
          ? `- **Activity:** ${activityLine(lead)}`
          : "",
        buyingEvidenceLine(lead)
          ? `- **Buying evidence signal (system-generated, unverified):** ${buyingEvidenceLine(lead)}`
          : "",
        ragLine(lead)
          ? `- **RAG reference (not company-specific evidence):** ${ragLine(lead)}`
          : "",
        `- **Fit-probability signal (system-generated, not independent evidence):** ${fitProbabilityLine(lead.fit ?? computeFitProbability(brief, lead))}`,
        `- **Excerpt:** ${clip(extraction?.summary || lead.exa.summary || lead.exa.text, 180)}`,
        `</candidate>`,
      ]

      return lines.filter(Boolean).join("\n")
    })
    .join("\n")

  const instructions = parallelInstructions(brief, also)

  const payload = [
    "```input_data",
    `Suppliers to evaluate: ${suppliers}, from ${brief.originCountry}.`,
    "PRELIMINARY CANDIDATE CARDS:",
    "<candidate_cards>",
    cards,
    "</candidate_cards>",
    "```",
  ].join("\n")

  const header = `${instructions}\n\n`
  const room = Math.max(0, 20000 - header.length)

  return `${header}${payload.slice(0, room)}`
}

export function diligenceInstructions(brief: Brief, brand: string): string {
  const kind = brand.toLowerCase().includes("kanechom")
    ? "Kanechom is mass-market retail hair care. Grocery, drugstore, and low-end wholesale are the channel. Skala or a similar mass brand is a positive portfolio signal. A salon-only account is a conflict."
    : brand.toLowerCase().includes("lq")
      ? "LQ Professional is salon hair care, including straightening. The buyer must reach salons and be able to train hairdressers. A grocery-only Skala book is a conflict."
      : `${brand} is the supplier being placed. Judge channel and portfolio only against this brief: ${brief.products}.`

  return [
    evidenceRule(),
    "You write a commercial due diligence note for one company and one brand. Use only the dossier and complementary-search notes. Do not invent contacts, imports, volumes, exclusivities, or intent to buy.",
    kind,
    "Do not return an opportunity score or a confidence level. The desk calculates those from the facts.",
    "Separate facts, indications, interpretations, and items that still need a human. If a search found nothing, that is absence, not proof of the opposite.",
    "Not finding an import record does not mean the company does not import.",
    "priority of pursue, if you mention it, would only mean a salesperson should approach — never a confirmed purchase.",
    "Quote URLs already in the dossier. Leave a field empty when unpublished.",
  ].join(" ")
}
