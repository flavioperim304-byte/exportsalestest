/**
 * Score comparison: current rule (cap at medium without a published buy fact) vs no rule.
 *   npx tsx scripts/uplift-compare.ts --out=reports
 * Part A uses SYNTHETIC test cases (clearly labeled). Part B uses the 84 real saved leads.
 */
import fs from "node:fs"
import path from "node:path"
import seedRuns from "../lib/data/seed-runs.json"
import { SIGNAL_TYPE_LABEL } from "../lib/signals/events"
import { UPLIFT_WEIGHTS, computeUplift } from "../lib/signals/uplift"
import type { Lead, Run, SignalEvent, SignalType } from "../lib/types"

const NOW = Date.now()
const LEVELS = ["low", "medium", "high"] as const
const PT: Record<string, string> = { low: "baixo", medium: "médio", high: "alto" }

function syntheticEvent(type: SignalType): SignalEvent {
  return {
    id: `synthetic-${type}`,
    type,
    subtype: `synthetic/${type}`,
    occurredAt: new Date(NOW - 90 * 86400000).toISOString(),
    detectedAt: new Date(NOW).toISOString(),
    source: "autobound",
    confidence: { level: "high", basis: "caso de teste" },
    evidence: { url: `https://example.test/${type}` },
    stageVersion: "synthetic",
  }
}

function syntheticLead(types: SignalType[]): Lead {
  return { id: "s", name: "Caso de teste", domain: "example.test", url: "https://example.test", country: "", signalEvents: types.map(syntheticEvent) } as unknown as Lead
}

const SCENARIOS: { label: string; types: SignalType[] }[] = [
  { label: "Sem sinais", types: [] },
  { label: "Só notícia / parceria", types: ["news", "commercial_activity"] },
  { label: "Contratação", types: ["hiring"] },
  { label: "Evento / feira", types: ["event"] },
  { label: "Contratação + evento", types: ["hiring", "event"] },
  { label: "Lançamento de produto", types: ["product_launch"] },
  { label: "Expansão", types: ["expansion"] },
  { label: "Lançamento + contratação", types: ["product_launch", "hiring"] },
  { label: "Intenção de compra", types: ["buyer_intent"] },
]

const md: string[] = []
md.push("# Score com regra × sem regra", "")
md.push(`Pesos: ${Object.entries(UPLIFT_WEIGHTS).map(([type, weight]) => `${SIGNAL_TYPE_LABEL[type as SignalType]} +${weight}`).join(", ")}. Cada tipo conta uma vez. Notícia, atividade comercial e outros: 0. Teto: alto.`, "")
md.push("- **Com regra** (atual): sem prova publicada de compra, estoque ou venda, os sinais levam no máximo a *médio*.")
md.push("- **Sem regra**: os sinais podem levar até *alto*.")
md.push("- Nenhum caso reduz o nível do modelo.", "")
md.push("## A. Casos de teste (fictícios, só para mostrar a regra)", "")
md.push("Empresa **sem** prova publicada de compra:", "")
md.push("| Cenário | Pontos | Base baixo: com regra / sem regra | Base médio: com regra / sem regra | Base alto: com regra / sem regra |", "|---|---|---|---|---|")
for (const scenario of SCENARIOS) {
  const lead = syntheticLead(scenario.types)
  const cells = LEVELS.map((from) => {
    const withRule = computeUplift(from, lead, "cap_medium_without_buy_fact", NOW, false)
    const noRule = computeUplift(from, lead, "no_cap", NOW, false)
    return `${PT[withRule.to]}${withRule.capped ? "*" : ""} / ${PT[noRule.to]}`
  })
  md.push(`| ${scenario.label} | +${computeUplift("low", lead, "no_cap", NOW, false).points} | ${cells.join(" | ")} |`)
}
md.push("", "\\* limitado pela regra atual (sem a regra, subiria mais).", "")
md.push("Empresa **com** prova publicada de compra: os dois cenários dão o mesmo resultado (a regra não limita).", "")

md.push("## B. Dados reais: 84 leads salvas no projeto", "")
const runs = (seedRuns as unknown as { runs: Run[] }).runs
let total = 0
let changedWith = 0
let changedWithout = 0
let withSignals = 0
for (const run of runs) {
  for (const lead of run.leads ?? []) {
    const icp = lead.context?.icp || lead.openai?.icp
    if (icp !== "low" && icp !== "medium" && icp !== "high") continue
    total += 1
    if ((lead.signalEvents ?? []).length) withSignals += 1
    if (computeUplift(icp, lead, "cap_medium_without_buy_fact", NOW).to !== icp) changedWith += 1
    if (computeUplift(icp, lead, "no_cap", NOW).to !== icp) changedWithout += 1
  }
}
md.push(`- Leads com score: **${total}** · com sinais gravados: **${withSignals}**`)
md.push(`- Mudaram com regra: **${changedWith}** · sem regra: **${changedWithout}**`)
md.push("- Essas execuções foram salvas antes da etapa de sinais, então nenhuma tem eventos: todas mantêm o score. A comparação real com as 5 leads sai do teste com as APIs.")

const out = process.argv.find((item) => item.startsWith("--out="))?.slice(6) || "reports"
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, "score-com-e-sem-regra.md"), md.join("\n"))
console.log(md.join("\n"))
