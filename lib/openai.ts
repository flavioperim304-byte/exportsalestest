import { activityLine } from "./activity"
import { signalCardLines } from "./signals/uplift"
import { buyingEvidenceLine, computeFitProbability, fitProbabilityLine } from "./fit-probability"
import type { Brief, DiligenceFinding, DiligenceProbe, FitJudgment, Lead } from "./types"
import { ApiError, requestJson } from "./http"
import { diligenceInstructions, openaiInstructions } from "./prompts"
import { ragLine } from "./rag"
import { asString, clip } from "./text"

export type OpenAIJudgment = FitJudgment & { company: string }

export type OpenAIEntry = {
  purchaseProbability: "high" | "medium" | "low" | ""
  purchaseNote: string
  strategy: string
}

const MODELS = ["gpt-4.1-mini", "gpt-4o-mini"]

function levelOf(value: unknown): "high" | "medium" | "low" | undefined {
  const text = asString(value).toLowerCase()
  if (text === "high" || text === "medium" || text === "low") return text
  return undefined
}

function fits(value: unknown): FitJudgment["supplierFits"] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      const level = levelOf(row.level)
      const supplier = asString(row.supplier)
      if (!supplier || !level) return null
      return { supplier, level }
    })
    .filter((item): item is FitJudgment["supplierFits"][number] => Boolean(item))
}

export function judgmentsFromOpenAI(data: unknown): OpenAIJudgment[] {
  const content = (() => {
    if (!data || typeof data !== "object") return ""
    const choice = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    const raw = choice?.message?.content
    return typeof raw === "string" ? raw : ""
  })()
  if (!content.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const leads = (parsed as { leads?: unknown } | null)?.leads
  if (!Array.isArray(leads)) return []
  return leads
    .map((item) => {
      const row = (item ?? {}) as Record<string, unknown>
      const icp = levelOf(row.icp)
      const company = asString(row.company)
      if (!company || !icp) return null
      return {
        company,
        icp,
        supplierFits: fits(row.supplier_fits),
        bestFit: asString(row.best_fit) || "neither",
        qualificationNeeded: asString(row.qualification_needed),
        rationale: asString(row.rationale),
      }
    })
    .filter((item): item is OpenAIJudgment => Boolean(item))
}

export function entryFromOpenAI(data: unknown): OpenAIEntry {
  const empty: OpenAIEntry = { purchaseProbability: "", purchaseNote: "", strategy: "" }
  const content = (() => {
    if (!data || typeof data !== "object") return ""
    const choice = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    const raw = choice?.message?.content
    return typeof raw === "string" ? raw : ""
  })()
  if (!content.trim()) return empty
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    return {
      purchaseProbability: levelOf(parsed.purchase_probability) ?? "",
      purchaseNote: asString(parsed.purchase_probability_note),
      strategy: asString(parsed.entry_strategy),
    }
  } catch {
    return empty
  }
}

function schema(suppliers: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      leads: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            company: { type: "string" },
            icp: { type: "string", enum: ["high", "medium", "low"] },
            rationale: {
              type: "string",
              description:
                "Only facts present on the candidate card, cited URLs, or the RAG line. Empty fields stay unpublished. Do not invent.",
            },
            supplier_fits: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  supplier: { type: "string", enum: suppliers },
                  level: { type: "string", enum: ["high", "medium", "low"] },
                },
                required: ["supplier", "level"],
              },
            },
            best_fit: { type: "string" },
            qualification_needed: { type: "string" },
          },
          required: [
            "company",
            "icp",
            "rationale",
            "supplier_fits",
            "best_fit",
            "qualification_needed",
          ],
        },
      },
      purchase_probability: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Chance a qualified buyer in this search market would take the brand on. Not a percentage.",
      },
      purchase_probability_note: { type: "string" },
      entry_strategy: {
        type: "string",
        description: "How to enter this market, from practices that have worked for professional brands.",
      },
    },
    required: ["leads", "purchase_probability", "purchase_probability_note", "entry_strategy"],
  }
}

function cards(brief: Brief, leads: Lead[]): string {
  return leads
    .map((lead, index) => {
      const extraction = lead.extraction
      return [
        `<candidate index="${index + 1}">`,
        `- **Name:** ${lead.name}`,
        lead.market ? `- **Market:** searched for ${lead.market}` : "",
        lead.buyerType ? `- **Buyer type:** searched as ${lead.buyerType}` : "",
        `- **URL:** ${lead.url}`,
        extraction?.role ? `- **Role:** ${extraction.role}` : "",
        `- **Country:** ${extraction?.country || lead.country || "unpublished"}`,
        extraction?.keyPerson
          ? `- **Key person:** ${extraction.keyPerson}${extraction.keyPersonRole ? ` (${extraction.keyPersonRole})` : ""}`
          : "",
        extraction?.email ? `- **Email:** ${extraction.email}` : "",
        extraction?.phone ? `- **Phone:** ${extraction.phone}` : "",
        extraction?.whatsapp ? `- **WhatsApp:** ${extraction.whatsapp}` : "",
        extraction?.latestHires?.length ? `- **Latest hires:** ${extraction.latestHires.slice(0, 3).join("; ")}` : "",
        extraction?.buys?.length ? `- **Buys:** ${extraction.buys.slice(0, 4).join("; ")}` : "",
        activityLine(lead) ? `- **Activity:** ${activityLine(lead)}` : "",
        signalCardLines(lead).length ? `- **Signals:**\n${signalCardLines(lead).join("\n")}` : "- **Signals:** none detected",
        buyingEvidenceLine(lead) ? `- **Buying evidence:** ${buyingEvidenceLine(lead)}` : "",
        ragLine(lead) ? `- **RAG:** ${ragLine(lead)}` : "",
        `- **Fit-probability:** ${fitProbabilityLine(lead.fit ?? computeFitProbability(brief, lead))}`,
        `- **Excerpt:** ${clip(extraction?.summary || lead.exa.summary || lead.exa.text, 320)}`,
        `</candidate>`,
      ]
        .filter(Boolean)
        .join("\n")
    })
    .join("\n")
}

export async function scoreLeads(
  brief: Brief,
  leads: Lead[],
  key: string,
  also?: Brief
): Promise<{ leads: OpenAIJudgment[]; entry: OpenAIEntry }> {
  const suppliers = [brief.supplierName, also?.supplierName].filter((name): name is string =>
    Boolean(name)
  )
  const body = {
    messages: [
      { role: "system", content: openaiInstructions(brief, also) },
      {
        role: "user",
        content: ["<candidate_cards>", cards(brief, leads), "</candidate_cards>"].join("\n"),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "lead_scores", strict: true, schema: schema(suppliers) },
    },
  }
  let lastError: unknown
  for (const model of MODELS) {
    try {
      const data = await requestJson("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        timeoutMs: 90000,
        headers: { Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, model }),
      })
      return { leads: judgmentsFromOpenAI(data), entry: entryFromOpenAI(data) }
    } catch (error) {
      lastError = error
      if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI rejected the score.")
}

export type DiligenceDraft = {
  findings: DiligenceFinding[]
  narratives: Partial<
    Record<"structure" | "portfolio" | "import" | "recentActivity" | "opportunity" | "approach", string>
  >
  citations: { url: string; title: string; publishedAt?: string }[]
}

function findingOf(row: Record<string, unknown>): DiligenceFinding | null {
  const kind = asString(row.kind)
  const polarity = asString(row.polarity)
  const text = asString(row.text)
  if (!text) return null
  if (!["fact", "indication", "interpretation", "needs_confirmation"].includes(kind)) return null
  if (!["supports", "against", "absent", "neutral"].includes(polarity)) return null
  const urls = Array.isArray(row.urls) ? row.urls.map((item) => asString(item)).filter(Boolean) : []
  return {
    kind: kind as DiligenceFinding["kind"],
    polarity: polarity as DiligenceFinding["polarity"],
    topic: asString(row.topic) || "channel",
    text: clip(text, 400),
    urls,
    evidenceAt: asString(row.evidence_at) || undefined,
  }
}

export function draftFromOpenAI(data: unknown): DiligenceDraft {
  const empty: DiligenceDraft = { findings: [], narratives: {}, citations: [] }
  const content = (() => {
    if (!data || typeof data !== "object") return ""
    const choice = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]
    const raw = choice?.message?.content
    return typeof raw === "string" ? raw : ""
  })()
  if (!content.trim()) return empty
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings
          .map((item) => findingOf((item ?? {}) as Record<string, unknown>))
          .filter((item): item is DiligenceFinding => Boolean(item))
      : []
    const citations: DiligenceDraft["citations"] = []
    if (Array.isArray(parsed.citations)) {
      for (const item of parsed.citations) {
        const row = (item ?? {}) as Record<string, unknown>
        const url = asString(row.url)
        if (!url) continue
        const publishedAt = asString(row.published_at)
        citations.push({
          url,
          title: asString(row.title) || url,
          ...(publishedAt ? { publishedAt } : {}),
        })
      }
    }
    return {
      findings,
      narratives: {
        structure: asString(parsed.structure) || undefined,
        portfolio: asString(parsed.portfolio) || undefined,
        import: asString(parsed.import_note) || undefined,
        recentActivity: asString(parsed.recent_activity) || undefined,
        opportunity: asString(parsed.opportunity) || undefined,
        approach: asString(parsed.approach) || undefined,
      },
      citations,
    }
  } catch {
    return empty
  }
}

const DILIGENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    structure: { type: "string" },
    portfolio: { type: "string" },
    import_note: { type: "string" },
    recent_activity: { type: "string" },
    opportunity: { type: "string" },
    approach: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["fact", "indication", "interpretation", "needs_confirmation"] },
          polarity: { type: "string", enum: ["supports", "against", "absent", "neutral"] },
          topic: { type: "string" },
          text: { type: "string" },
          urls: { type: "array", items: { type: "string" } },
          evidence_at: { type: "string" },
        },
        required: ["kind", "polarity", "topic", "text", "urls", "evidence_at"],
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          published_at: { type: "string" },
        },
        required: ["url", "title", "published_at"],
      },
    },
  },
  required: [
    "structure",
    "portfolio",
    "import_note",
    "recent_activity",
    "opportunity",
    "approach",
    "findings",
    "citations",
  ],
}

export async function draftDiligence(
  brief: Brief,
  brand: string,
  lead: Lead,
  probes: DiligenceProbe[],
  key: string
): Promise<DiligenceDraft> {
  const extraction = lead.extraction
  const dossier = [
    `Company: ${lead.name}`,
    `Brand under review: ${brand}`,
    lead.market ? `Search market: ${lead.market}` : "",
    lead.url,
    extraction?.role,
    extraction?.summary,
    extraction?.buys?.slice(0, 6).join("; "),
    activityLine(lead),
    buyingEvidenceLine(lead),
    ragLine(lead),
    fitProbabilityLine(lead.fit ?? computeFitProbability(brief, lead)),
    probes.length
      ? `Complementary probes:\n${probes
          .map((probe) => `${probe.questionId} · ${probe.result} · ${probe.question} · ${probe.note}`)
          .join("\n")}`
      : "No complementary search ran.",
  ]
    .filter(Boolean)
    .join("\n")
  const body = {
    messages: [
      { role: "system", content: diligenceInstructions(brief, brand) },
      { role: "user", content: dossier },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "diligence_draft", strict: true, schema: DILIGENCE_SCHEMA },
    },
  }
  let lastError: unknown
  for (const model of MODELS) {
    try {
      const data = await requestJson("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        timeoutMs: 90000,
        headers: { Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...body, model }),
      })
      return draftFromOpenAI(data)
    } catch (error) {
      lastError = error
      if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) {
        throw error
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("OpenAI rejected the due diligence draft.")
}
