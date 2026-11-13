import type { Brief, Competitor, Lead, MarketContext } from "./types"
import { ApiError, requestJson } from "./http"
import { evidenceRule, researchPrompt } from "./prompts"
import { modelIcp, signalCardLines } from "./signals/uplift"
import { ragLine } from "./rag"
import { asString, asStringArray } from "./text"

export { researchPrompt }

export type ParsedResearch = {
  market: MarketContext
  competitors: Competitor[]
  leads: {
    company: string
    fitNarrative: string
    knownSuppliers: string[]
    risks: string[]
    citations: string[]
    icp?: "high" | "medium" | "low"
    supplierFits: { supplier: string; level: "high" | "medium" | "low" }[]
    bestFit: string
    qualificationNeeded: string
  }[]
}

const OUTPUT_SCHEMA = {
  type: "json",
  json_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      purchase_probability: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "Chance a qualified buyer in this search market would take the brand on. High only with at least two published facts among last purchase, stock, brand performance, sales, and a competitor move, plus recent public activity. Not a percentage. Do not invent those facts.",
      },
      purchase_probability_note: { type: "string" },
      entry_strategy: {
        type: "string",
        description: "How to enter this market, from practices that have worked for professional brands. Cite the practice.",
      },
      outlook: {
        type: "string",
        description: "Market outlook for the supplier products in the target markets. Include figures only when a source states them.",
      },
      buyer_dynamics: {
        type: "string",
        description: "How buyers in these markets actually purchase this category.",
      },
      import_signals: { type: "array", items: { type: "string" } },
      market_citations: { type: "array", items: { type: "string" } },
      competitors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            country: {
              type: "string",
              description:
                "The search-market country where this rival already sells. Not the brand headquarters and not the supplier origin country. If a Brazilian brand sells in Colombia, country is Colombia.",
            },
            why_relevant: {
              type: "string",
              description:
                "Why this rival matters in the search-market country. Name the local presence a source shows.",
            },
            url: { type: "string" },
          },
          required: ["name", "country", "why_relevant", "url"],
        },
      },
      leads: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: { type: "string" },
            fit_narrative: { type: "string" },
            known_suppliers: {
              type: "array",
              items: { type: "string" },
              description:
                "Brands a cited URL names for this company. Empty when unpublished. Do not invent from training memory or from a RAG neighbor.",
            },
            risks: { type: "array", items: { type: "string" } },
            citations: { type: "array", items: { type: "string" } },
            icp: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Overall product and channel fit. Not a confirmed purchase.",
            },
            supplier_fits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  supplier: { type: "string" },
                  level: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["supplier", "level"],
              },
            },
            best_fit: {
              type: "string",
              description: "Supplier name, both, or neither.",
            },
            qualification_needed: { type: "string" },
          },
          required: [
            "company",
            "fit_narrative",
            "known_suppliers",
            "risks",
            "citations",
            "icp",
            "supplier_fits",
            "best_fit",
            "qualification_needed",
          ],
        },
      },
    },
    required: [
      "purchase_probability",
      "purchase_probability_note",
      "entry_strategy",
      "outlook",
      "buyer_dynamics",
      "import_signals",
      "market_citations",
      "competitors",
      "leads",
    ],
  },
}

export async function createResearch(
  brief: Brief,
  leads: Lead[],
  key: string,
  also?: Brief
): Promise<{ runId: string; interactionId?: string; processor: string }> {
  const input = researchPrompt(brief, leads, also)
  const processors = ["pro-fast", "pro"]
  let lastError: unknown
  for (const processor of processors) {
    try {
      const data = await requestJson("https://api.parallel.ai/v1/tasks/runs", {
        method: "POST",
        timeoutMs: 40000,
        headers: { "x-api-key": key },
        body: JSON.stringify({
          input,
          processor,
          task_spec: { output_schema: OUTPUT_SCHEMA },
        }),
      })
      const record = (data ?? {}) as { run_id?: string; interaction_id?: string }
      if (!record.run_id) {
        throw new ApiError("Parallel did not return a run id.", 502)
      }
      return {
        runId: record.run_id,
        interactionId: record.interaction_id,
        processor,
      }
    } catch (error) {
      lastError = error
      if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 422)) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Parallel rejected the research task.")
}

export async function researchStatus(
  runId: string,
  key: string
): Promise<{ status: string; error?: string }> {
  const data = await requestJson(`https://api.parallel.ai/v1/tasks/runs/${runId}`, {
    method: "GET",
    timeoutMs: 20000,
    headers: { "x-api-key": key },
  })
  const record = (data ?? {}) as { status?: string; error?: unknown; run?: { status?: string } }
  const status = record.status || record.run?.status || "unknown"
  const error =
    typeof record.error === "string"
      ? record.error
      : record.error
        ? JSON.stringify(record.error).slice(0, 300)
        : undefined
  return { status, error }
}

function basisUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const urls: string[] = []
  for (const field of value) {
    if (!field || typeof field !== "object") continue
    const citations = (field as { citations?: unknown }).citations
    if (!Array.isArray(citations)) continue
    for (const citation of citations) {
      if (citation && typeof citation === "object" && typeof (citation as { url?: unknown }).url === "string") {
        urls.push((citation as { url: string }).url)
      }
    }
  }
  return urls
}

function levelOf(value: unknown): "high" | "medium" | "low" | undefined {
  const text = asString(value).toLowerCase()
  if (text === "high" || text === "medium" || text === "low") return text
  return undefined
}

function supplierFits(value: unknown): { supplier: string; level: "high" | "medium" | "low" }[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      const level = levelOf(row.level)
      const supplier = asString(row.supplier)
      if (!supplier || !level) return null
      return { supplier, level }
    })
    .filter((item): item is { supplier: string; level: "high" | "medium" | "low" } => Boolean(item))
}

export function parseResearch(data: unknown): ParsedResearch | null {
  if (!data || typeof data !== "object") return null
  const root = data as { output?: { content?: unknown; basis?: unknown }; content?: unknown }
  const output = root.output
  const content = output?.content ?? root.content
  const citations = basisUrls(output?.basis)

  if (typeof content === "string" && content.trim()) {
    return {
      market: {
        outlook: content.trim(),
        buyerDynamics: "",
        importSignals: [],
        citations,
        purchaseProbability: "",
        purchaseNote: "",
        entryStrategy: "",
      },
      competitors: [],
      leads: [],
    }
  }
  if (!content || typeof content !== "object") return null
  const record = content as Record<string, unknown>
  const competitors = Array.isArray(record.competitors) ? record.competitors : []
  const leads = Array.isArray(record.leads) ? record.leads : []
  const marketCitations = [...asStringArray(record.market_citations), ...citations]
  return {
    market: {
      outlook: asString(record.outlook),
      buyerDynamics: asString(record.buyer_dynamics),
      importSignals: asStringArray(record.import_signals).slice(0, 8),
      citations: [...new Set(marketCitations)].slice(0, 12),
      purchaseProbability: levelOf(record.purchase_probability) ?? "",
      purchaseNote: asString(record.purchase_probability_note),
      entryStrategy: asString(record.entry_strategy),
    },
    competitors: competitors
      .map((item) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          name: asString(row.name),
          country: asString(row.country),
          whyRelevant: asString(row.why_relevant),
          url: asString(row.url),
        }
      })
      .filter((item) => item.name)
      .slice(0, 6),
    leads: leads
      .map((item) => {
        const row = (item ?? {}) as Record<string, unknown>
        return {
          company: asString(row.company),
          fitNarrative: asString(row.fit_narrative),
          knownSuppliers: asStringArray(row.known_suppliers).slice(0, 6),
          risks: asStringArray(row.risks).slice(0, 6),
          citations: asStringArray(row.citations).slice(0, 6),
          icp: levelOf(row.icp),
          supplierFits: supplierFits(row.supplier_fits),
          bestFit: asString(row.best_fit),
          qualificationNeeded: asString(row.qualification_needed),
        }
      })
      .filter((item) => item.company),
  }
}

export async function researchResult(runId: string, key: string): Promise<ParsedResearch | null> {
  const data = await requestJson(`https://api.parallel.ai/v1/tasks/runs/${runId}/result`, {
    method: "GET",
    timeoutMs: 30000,
    headers: { "x-api-key": key },
  })
  return parseResearch(data)
}

const DECISION_QUESTION_LIMIT = 100
const DECISION_STATE_CHARS = 24000
const DECISION_QUESTION_CHARS = 5000

type DecisionQuestion = {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export type DecisionRequest = {
  mode: "fast"
  include_excerpts: false
  state: Record<string, unknown>
  questions: Record<string, DecisionQuestion>
}

type DecisionAnswer = {
  type?: string
  choice?: string
  probabilities?: Record<string, number>
}

function choiceAnswer(value: unknown): { refused: boolean; choice: string; probability?: number } {
  const answer = (value ?? {}) as DecisionAnswer
  if (answer.type === "refusal") return { refused: true, choice: "" }
  const choice = asString(answer.choice)
  const probability = answer.probabilities?.[choice]
  return {
    refused: false,
    choice,
    probability: typeof probability === "number" ? probability : undefined,
  }
}

function probabilityNote(choice: string, probability?: number): string {
  if (!choice) return ""
  if (typeof probability !== "number") return `Parallel Decisions chose ${choice}.`
  return `Parallel Decisions chose ${choice} at probability ${probability.toFixed(2)}.`
}

function clipState(state: Record<string, unknown>): Record<string, unknown> {
  let prompt = asString(state.prompt)
  let evidence = asString(state.evidence)
  const candidates = Array.isArray(state.candidates)
    ? (state.candidates as { note?: string; rag?: string; signals?: string }[])
    : []
  const sized = () => JSON.stringify({ ...state, prompt, evidence, candidates }).length
  while (sized() > DECISION_STATE_CHARS && candidates.some((item) => (item.note ?? "").length > 40)) {
    for (const item of candidates) {
      if ((item.note ?? "").length > 40) item.note = (item.note ?? "").slice(0, 40)
    }
  }
  while (sized() > DECISION_STATE_CHARS && candidates.some((item) => (item.rag ?? "").length > 40)) {
    for (const item of candidates) {
      if ((item.rag ?? "").length > 40) item.rag = (item.rag ?? "").slice(0, 40)
    }
  }
  while (sized() > DECISION_STATE_CHARS && candidates.some((item) => (item.signals ?? "").length > 80)) {
    for (const item of candidates) {
      if ((item.signals ?? "").length > 80) item.signals = (item.signals ?? "").slice(0, 80)
    }
  }
  while (sized() > DECISION_STATE_CHARS && evidence.length > 200) {
    evidence = evidence.slice(0, Math.floor(evidence.length * 0.7))
  }
  while (sized() > DECISION_STATE_CHARS && prompt.length > 400) {
    prompt = prompt.slice(0, Math.floor(prompt.length * 0.7))
  }
  return { ...state, prompt, evidence, candidates }
}

function fitQuestion(kind: Brief["searchKind"]): DecisionQuestion {
  return {
    type: "choice",
    instructions:
      kind === "competitors"
        ? "Is this company the brand’s distributor or a direct competitor distributor in the searched country? Select unknown when the evidence is insufficient. Never invent a role."
        : "Does this company fit the buyer role in the prompt, in the searched country? Select unknown when the evidence is insufficient. Never invent a role.",
    criteria: {
      high: "A source shows the role in the searched country.",
      medium: "The role is plausible, but a source does not prove it.",
      low: "A retailer, a salon, an unrelated company, or a company outside the searched country.",
      unknown: "The evidence does not establish the role.",
    },
  }
}

function bestQuestion(brief: Brief, also?: Brief): DecisionQuestion {
  const criteria: Record<string, string> = {
    pursue: `Approach this company for ${brief.supplierName}.`,
    neither: "Do not pursue this company.",
    unknown: "The evidence does not establish who to pursue.",
  }
  if (brief.searchKind === "competitors") {
    criteria.competitor = "A direct competitor distributor of a rival brand in the same country."
  }
  if (also) criteria.both = `Pursue both ${brief.supplierName} and ${also.supplierName}.`
  return {
    type: "choice",
    instructions: "Who should the salesperson pursue at this company? Select unknown when the evidence is insufficient.",
    criteria,
  }
}

function marketQuestions(): Record<string, DecisionQuestion> {
  return {
    purchase_probability: {
      type: "choice",
      instructions:
        "What is the chance a qualified buyer in this search market would take the brand on? This is not a confirmed order. Select unknown when the evidence is insufficient.",
      criteria: {
        high: "Sources show an open professional channel for a new brand.",
        medium: "The channel exists, but a source does not show room for another brand.",
        low: "Sources show a closed, exclusive, or absent channel.",
        unknown: "The evidence does not establish the chance.",
      },
    },
    entry_strategy: {
      type: "choice",
      instructions:
        "Which entry practice do sources support for this market? Select unknown when a source does not support one.",
      criteria: {
        importer: "Appoint one importer before many retailers, then train that channel.",
        trial: "Open with a non-exclusive trial and price inside the local professional tier.",
        train: "Train the existing professional channel before opening retail.",
        unknown: "A source does not support a specific entry practice.",
      },
    },
  }
}

function renderedQuestion(name: string, question: DecisionQuestion): number {
  return JSON.stringify({ [name]: question }).length
}

export function buildDecisionRequests(brief: Brief, leads: Lead[], also?: Brief): DecisionRequest[] {
  const state = clipState({
    supplier: brief.supplierName,
    origin: brief.originCountry,
    website: brief.website,
    markets: brief.markets,
    excluded: brief.excludedMarkets ?? "",
    kind: brief.searchKind === "competitors" ? "competitors" : "buyers",
    otherSupplier: also?.supplierName ?? "",
    evidence: evidenceRule(),
    prompt: (brief.instructions ?? "").slice(0, 4000),
    candidates: leads.map((lead, index) => ({
      key: `c${index}`,
      name: lead.name,
      country: lead.market || lead.extraction?.country || lead.country,
      url: lead.url,
      role: lead.extraction?.role ?? "",
      preliminary: modelIcp(lead, "openai") ?? "",
      signals: signalCardLines(lead, 3).join(" | ").slice(0, 300),
      note: (lead.extraction?.summary || lead.exa.summary || lead.exa.text || "").slice(0, 180),
      rag: ragLine(lead),
    })),
  })
  const questions: [string, DecisionQuestion][] = Object.entries(marketQuestions())
  leads.forEach((_, index) => {
    questions.push([`c${index}_fit`, fitQuestion(brief.searchKind)])
    questions.push([`c${index}_best`, bestQuestion(brief, also)])
  })
  for (const [name, question] of questions) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Decision question name is not allowed: ${name}`)
    }
    if (renderedQuestion(name, question) > DECISION_QUESTION_CHARS) {
      throw new Error(`Decision question ${name} exceeds ${DECISION_QUESTION_CHARS} characters.`)
    }
  }
  const requests: DecisionRequest[] = []
  for (let start = 0; start < questions.length; start += DECISION_QUESTION_LIMIT) {
    const slice = questions.slice(start, start + DECISION_QUESTION_LIMIT)
    requests.push({
      mode: "fast",
      include_excerpts: false,
      state,
      questions: Object.fromEntries(slice),
    })
  }
  return requests
}

const ENTRY_TEXT: Record<string, string> = {
  importer: "Appoint one importer before many retailers, then train that channel.",
  trial: "Open with a non-exclusive trial and price inside the local professional tier.",
  train: "Train the existing professional channel before opening retail.",
}

export function parseDecisions(
  brief: Brief,
  leads: Lead[],
  responses: unknown[],
  also?: Brief
): ParsedResearch {
  const answers: Record<string, unknown> = {}
  const citations: string[] = []
  for (const response of responses) {
    const record = (response ?? {}) as { answers?: Record<string, unknown>; citations?: unknown[] }
    Object.assign(answers, record.answers ?? {})
    for (const citation of record.citations ?? []) {
      const url = asString((citation as { url?: unknown })?.url)
      if (url) citations.push(url)
    }
  }
  const purchase = choiceAnswer(answers.purchase_probability)
  const entry = choiceAnswer(answers.entry_strategy)
  const purchaseLevel = levelOf(purchase.choice)
  const parsedLeads = leads.map((lead, index) => {
    const fit = choiceAnswer(answers[`c${index}_fit`])
    const best = choiceAnswer(answers[`c${index}_best`])
    const icp = fit.refused ? undefined : levelOf(fit.choice)
    let bestFit = ""
    if (!best.refused && best.choice === "pursue") bestFit = brief.supplierName
    if (!best.refused && best.choice === "both") bestFit = also ? "both" : brief.supplierName
    if (!best.refused && best.choice === "competitor") bestFit = "direct competitor"
    if (!best.refused && best.choice === "neither") bestFit = "neither"
    const refused = fit.refused || best.refused
    const unknown = !refused && (fit.choice === "unknown" || best.choice === "unknown" || !icp)
    const decided = icp && !refused && !unknown
    const supplierFits =
      decided && also && best.choice === "both"
        ? [
            { supplier: brief.supplierName, level: icp },
            { supplier: also.supplierName, level: icp },
          ]
        : decided
          ? [{ supplier: brief.supplierName, level: icp }]
          : []
    return {
      company: lead.name,
      fitNarrative: [
        refused ? "Parallel Decisions refused at least one question." : "",
        fit.refused ? "" : probabilityNote(fit.choice, fit.probability),
        best.refused ? "" : probabilityNote(best.choice, best.probability),
      ]
        .filter(Boolean)
        .join(" "),
      knownSuppliers: [],
      risks: [],
      citations: [],
      icp: decided ? icp : undefined,
      supplierFits,
      bestFit: decided ? bestFit : "",
      qualificationNeeded: refused
        ? "Parallel Decisions refused a question. Confirm the role before outreach."
        : unknown
          ? "Parallel Decisions did not have enough evidence. Confirm the role before outreach."
          : "Confirm the contact and the import role before outreach.",
    }
  })
  return {
    market: {
      outlook: purchase.refused
        ? "Parallel Decisions refused the purchase question."
        : purchaseLevel
          ? `Parallel Decisions (fast) calls the purchase probability ${purchaseLevel}.`
          : "Parallel Decisions did not have enough evidence to call the purchase probability.",
      buyerDynamics: "",
      importSignals: [],
      citations: [...new Set(citations)].slice(0, 12),
      purchaseProbability: purchase.refused ? "" : (purchaseLevel ?? ""),
      purchaseNote: purchase.refused
        ? "Parallel Decisions refused the purchase question."
        : probabilityNote(purchase.choice, purchase.probability),
      entryStrategy: entry.refused
        ? "Parallel Decisions refused the entry question."
        : (ENTRY_TEXT[entry.choice] ?? ""),
    },
    competitors: [],
    leads: parsedLeads,
  }
}

export function decisionOutline(brief: Brief): string {
  return [
    evidenceRule(),
    "Parallel Decisions, mode fast. Used only on this run. The default remains the Task API.",
    "One request holds at most 100 questions. A longer shortlist is split, and each call shares the same state.",
    "Questions: purchase probability (high, medium, low, unknown), entry practice (one importer, non-exclusive trial, train the channel, or unknown), then each company’s fit and who to pursue.",
    "A refusal or unknown leaves the OpenAI score in place for that company.",
    brief.instructions?.trim() ?? "",
  ]
    .filter(Boolean)
    .join("\n")
}

export async function decideResearch(
  brief: Brief,
  leads: Lead[],
  key: string,
  also?: Brief
): Promise<{ research: ParsedResearch; decisionId?: string }> {
  const requests = buildDecisionRequests(brief, leads, also)
  const responses: unknown[] = []
  let decisionId: string | undefined
  for (const body of requests) {
    const data = await requestJson("https://api.parallel.ai/v1/decisions", {
      method: "POST",
      timeoutMs: 120000,
      headers: { "x-api-key": key },
      body: JSON.stringify(body),
    })
    responses.push(data)
    const id = asString((data as { decision_id?: unknown })?.decision_id)
    if (id) decisionId = id
  }
  return { research: parseDecisions(brief, leads, responses, also), decisionId }
}

export function namesMatch(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
  const a = normalize(left)
  const b = normalize(right)
  if (!a || !b) return false
  return a === b || a.includes(b) || b.includes(a)
}
