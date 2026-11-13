/**
 * Phase 1 test harness for the versioned Autobound signals stage.
 *
 *   npx tsx scripts/signals-check.ts --mode=dry  [--out=reports]
 *   npx tsx scripts/signals-check.ts --mode=live --keys=/path/KEYS.txt,/path/autobound.txt [--budget=50] [--limit=5]
 *
 * dry:  sends nothing, needs no key. Prints every request and its worst-case cost.
 * live: GET free metadata (types, credits), then one enrich call per lead under a hard budget,
 *       plus the CURRENT Exa activity/commerce searches for a before/after comparison.
 * Keys are read from the files given, held in memory only, and never written to the report.
 */
import fs from "node:fs"
import path from "node:path"
import { searchActivity } from "../lib/activity"
import { searchCommerce } from "../lib/commerce"
import { publicError } from "../lib/http"
import {
  AUTOBOUND_STAGE_VERSION,
  CATALOG_ONLY_SIGNAL_TYPES,
  CREDITS_PER_SIGNAL_WORST_CASE,
  USER_CONFIRMED_SIGNAL_TYPES,
  CreditBudget,
  DEFAULT_RUN_BUDGET,
  DEFAULT_SIGNAL_LIMIT,
  enrichCompany,
  freeMetadata,
} from "../lib/signals/autobound"
import { SIGNAL_TYPE_LABEL, eventsFromExa } from "../lib/signals/events"
import { applyScan } from "../lib/signals/stage"
import { INTENT_CREDITS_PER_TOPIC_WORST_CASE, intentTimeline, searchIntentTopics } from "../lib/signals/intent"
import { computeUplift } from "../lib/signals/uplift"
import { scoreLeads } from "../lib/openai"
import seedRuns from "../lib/data/seed-runs.json"
import type { Run } from "../lib/types"
import { domainOf } from "../lib/text"
import type { Brief, Lead, SignalEvent, SignalScan } from "../lib/types"

type TestLead = { id: string; name: string; url: string; country: string; countryConfirmed: boolean; origin: string }

function arg(name: string, fallback = ""): string {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

/** KEY=VALUE or KEY: VALUE lines. A file holding a single bare token named *autobound* is the Autobound key. */
export function readKeyFiles(files: string[]): Record<string, string> {
  const keys: Record<string, string> = {}
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_ ]*?)\s*[=:]\s*(.+)$/)
      if (match) {
        const name = match[1].trim().toUpperCase().replace(/\s+/g, "_")
        keys[name] = match[2].trim().replace(/^["']|["']$/g, "")
      }
    }
    if (lines.length === 1 && !/[=:]/.test(lines[0]) && /autobound/i.test(path.basename(file))) {
      keys.AUTOBOUND_API_KEY = lines[0]
    }
  }
  return keys
}

function pickKey(keys: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const found = Object.entries(keys).find(([key]) => key === name || key.includes(name))
    if (found?.[1]) return found[1]
  }
  return undefined
}

/** Picks provider type names relevant to hiring/expansion/launch/news/commercial from the free types list. */
/** All strings found in the free type catalog (names/ids/slugs). */
export function catalogNames(data: unknown): Set<string> {
  const names = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === "string") names.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(data)
  return names
}

/**
 * Filter actually sent: the user-confirmed types, plus documented hiring types only when the
 * live catalog lists them. A user-confirmed type missing from a readable catalog is reported,
 * not silently dropped. Without a readable catalog, the user-confirmed list is sent as is.
 */
export function chooseSignalTypes(catalog: unknown | undefined): { send: string[]; missing: string[]; added: string[] } {
  if (!catalog) return { send: [...USER_CONFIRMED_SIGNAL_TYPES], missing: [], added: [] }
  const names = catalogNames(catalog)
  const missing = USER_CONFIRMED_SIGNAL_TYPES.filter((type) => !names.has(type))
  const added = CATALOG_ONLY_SIGNAL_TYPES.filter((type) => names.has(type))
  return { send: [...USER_CONFIRMED_SIGNAL_TYPES, ...added], missing, added }
}

export function relevantProviderTypes(data: unknown): string[] {
  const names = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === "string") names.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of ["signal_type", "type", "name", "id", "slug"]) {
        if (typeof record[key] === "string") names.add(record[key] as string)
      }
      for (const nested of Object.values(record)) if (typeof nested === "object") visit(nested)
    }
  }
  visit(data)
  return [...names].filter(
    (name) =>
      name.length < 60 &&
      /news|hir|job|expan|office|launch|partner|contract|funding|leadership/i.test(name) &&
      !/review|github|seo|traffic/i.test(name)
  )
}

function asLead(row: TestLead): Lead {
  return {
    id: row.id,
    name: row.name,
    domain: domainOf(row.url),
    url: row.url,
    country: row.country,
    market: row.country,
    exa: { highlights: [], summary: "", text: "" },
  } as unknown as Lead
}

function brief(): Brief {
  return { supplierName: "Teste de sinais", originCountry: "Brazil", markets: "Colombia, Panama, Ecuador, Peru", products: "hair care" } as unknown as Brief
}

function eventRow(event: SignalEvent): string {
  const date = event.occurredAt ? event.occurredAt.slice(0, 10) : "sem data"
  const title = (event.evidence.title || event.subtype).replace(/\|/g, "/")
  return `| ${SIGNAL_TYPE_LABEL[event.type]} | \`${event.subtype}\` | ${date} | ${event.source} | ${event.confidence.level} | [${title}](${event.evidence.url}) |`
}

function scanBlock(scan: SignalScan): string[] {
  const types = Object.entries(scan.types)
    .map(([type, status]) => `${SIGNAL_TYPE_LABEL[type as keyof typeof SIGNAL_TYPE_LABEL]}: ${status}`)
    .join(" · ")
  return [
    `- Status: **${scan.status}**${scan.error ? ` — ${scan.error}` : ""}`,
    `- Créditos (pior caso): ${scan.creditsEstimated}${scan.creditsReported ? ` · cabeçalhos do provedor: ${JSON.stringify(scan.creditsReported)}` : ""}`,
    `- Tipos: ${types || "—"}`,
    `- Descartados sem URL: ${scan.discarded}`,
    scan.request
      ? scan.endpoint === "intent_timeline"
        ? `- Requisição: \`GET ${scan.request.endpoint}\``
        : `- Requisição: \`POST ${scan.request.endpoint}\` \`${JSON.stringify(scan.request.body)}\``
      : "",
  ].filter(Boolean)
}

async function main() {
  const mode = arg("mode", "dry")
  const outDir = arg("out", "reports")
  const budgetCeiling = Number(arg("budget", String(DEFAULT_RUN_BUDGET)))
  const limit = Number(arg("limit", String(DEFAULT_SIGNAL_LIMIT)))
  const leadsFile = arg("leads", path.join(__dirname, "signals-leads.json"))
  const rows = (JSON.parse(fs.readFileSync(leadsFile, "utf8")) as { leads: TestLead[] }).leads
  const keys = mode === "live" ? readKeyFiles(arg("keys").split(",").filter(Boolean)) : {}
  const autobound = pickKey(keys, "AUTOBOUND_API_KEY", "AUTOBOUND")
  const exa = pickKey(keys, "EXA_API_KEY", "EXA")
  const openai = pickKey(keys, "OPENAI_API_KEY", "OPENAI")
  const scoring = arg("score") === "openai"
  const tested: Lead[] = []
  const topicIds = arg("topics").split(",").map((item) => item.trim()).filter(Boolean)
  const findTopics = arg("find-topics").split(",").map((item) => item.trim()).filter(Boolean)
  const secrets = Object.values(keys)
  const budget = new CreditBudget(budgetCeiling)
  const startedAt = new Date().toISOString()
  const md: string[] = []
  const json: Record<string, unknown> = { mode, startedAt, stageVersion: AUTOBOUND_STAGE_VERSION, budgetCeiling, limit, leads: [] }

  md.push(`# Demonstrativo — etapa de sinais ${AUTOBOUND_STAGE_VERSION}`, "")
  md.push(`- Modo: **${mode === "live" ? "teste real" : "simulação (nenhuma chamada enviada)"}**`)
  md.push(`- Gerado em: ${startedAt}`)
  md.push(`- Teto de créditos: **${budgetCeiling}** · Sinais por empresa: **${limit}** · Custo pior caso por empresa: **${limit * CREDITS_PER_SIGNAL_WORST_CASE}**`)
  md.push(`- Custo pior caso total: **${rows.length * limit * CREDITS_PER_SIGNAL_WORST_CASE}** créditos para ${rows.length} empresas`)
  md.push(`- Janela: últimos 24 meses (\`detected_after\`)`)
  md.push(`- Tipos pedidos ao enrich: \`${USER_CONFIRMED_SIGNAL_TYPES.join(", ")}\` (confirmados no painel do Autobound)`)
  md.push(
    topicIds.length
      ? `- Intenção de compra: ${topicIds.length} tópico(s) \`${topicIds.join(", ")}\`, pior caso ${topicIds.length * INTENT_CREDITS_PER_TOPIC_WORST_CASE} crédito(s) por empresa (custo documentado de duas formas: grátis ou 1 por linha empresa-tópico)`
      : "- Intenção de compra: não executada (nenhum tópico informado em --topics)"
  )
  md.push("")

  let signalTypes: string[] | undefined
  if (mode === "live") {
    if (!autobound) throw new Error("AUTOBOUND_API_KEY não encontrada nos arquivos informados.")
    // Autobound documents two paths for the free type catalog; try the llms-full.txt one first.
    let types = await freeMetadata("/signal-types", autobound).catch((error) => ({ ok: false, status: 0, data: publicError(error, secrets) }))
    if (!types.ok) {
      types = await freeMetadata("/signals/types", autobound).catch((error) => ({ ok: false, status: 0, data: publicError(error, secrets) }))
    }
    const creditsBefore = await freeMetadata("/credits", autobound).catch((error) => ({ ok: false, status: 0, data: publicError(error, secrets) }))
    const chosen = chooseSignalTypes(types.ok ? types.data : undefined)
    signalTypes = chosen.send
    json.signalTypesChosen = chosen
    json.providerTypes = types
    json.creditsBefore = creditsBefore
    md.push(`## Consultas gratuitas`, "")
    md.push(`- Lista de tipos (\`GET /v1/signal-types\` ou \`/v1/signals/types\`): HTTP ${types.status}${types.ok ? "" : " — falhou"}`)
    md.push(`- Filtro usado: \`${(signalTypes ?? []).join(", ")}\``)
    if (chosen.added.length) md.push(`- Incluídos porque o catálogo os lista: \`${chosen.added.join(", ")}\``)
    if (chosen.missing.length) md.push(`- Atenção: tipos confirmados no painel que o catálogo não listou (enviados mesmo assim): \`${chosen.missing.join(", ")}\``)
    md.push(`- Saldo antes (\`GET /v1/credits\`): HTTP ${creditsBefore.status} \`${JSON.stringify(creditsBefore.data).slice(0, 300)}\``, "")
    for (const query of findTopics) {
      const found = await searchIntentTopics(query, autobound).catch((error) => ({ ok: false, status: 0, data: publicError(error, secrets), credits: {} }))
      md.push(`- Busca de tópicos "${query}" (\`GET /v1/buyer-intent/topics\`): HTTP ${found.status}${Object.keys(found.credits).length ? ` · créditos: ${JSON.stringify(found.credits)}` : ""}`)
      md.push("```json", JSON.stringify(found.data, null, 2).slice(0, 1500), "```")
      ;((json.topicSearches as unknown[]) ??= []).push({ query, ...found })
    }
    md.push("")
  }

  for (const row of rows) {
    const lead = asLead(row)
    md.push(`## ${row.name} — ${lead.domain} (${row.country}${row.countryConfirmed ? "" : ", país não confirmado"})`, "")
    const entry: Record<string, unknown> = { lead: row, domain: lead.domain }

    // BEFORE: what the current flow finds (Exa activity + commerce), only in live mode.
    if (mode === "live" && exa) {
      try {
        lead.activity = await searchActivity(lead, brief(), exa)
      } catch (error) {
        lead.activity = { fetchedAt: new Date().toISOString(), signals: [], error: publicError(error, secrets) }
      }
      try {
        lead.commerce = await searchCommerce(lead, brief(), exa)
      } catch (error) {
        lead.commerce = { fetchedAt: new Date().toISOString(), signals: [], error: publicError(error, secrets) }
      }
    }
    const before = eventsFromExa(lead, AUTOBOUND_STAGE_VERSION)

    const result = await enrichCompany(lead.url, {
      key: autobound,
      budget,
      limit,
      signalTypes: signalTypes ?? [...USER_CONFIRMED_SIGNAL_TYPES],
      dryRun: mode !== "live",
      runId: `test-${startedAt}`,
    })
    if (result.scan.error) result.scan.error = publicError(result.scan.error, secrets)
    const scan = applyScan(lead, result.scan, result.events)

    md.push("**Enrich (sinais):**", ...scanBlock(scan), "")
    if (topicIds.length) {
      const intent = await intentTimeline(lead.url, { key: autobound, budget, topicIds, dryRun: mode !== "live", runId: `test-${startedAt}` })
      if (intent.scan.error) intent.scan.error = publicError(intent.scan.error, secrets)
      const intentScan = applyScan(lead, intent.scan, intent.events)
      md.push("**Intenção de compra (timeline):**", ...scanBlock(intentScan), "")
      entry.intentScan = intentScan
    }
    if (mode === "live") {
      md.push(`**Antes (fluxo atual, Exa):** ${before.length} sinais com evidência.${lead.activity?.error ? ` Erro atividade: ${lead.activity.error}` : ""}${lead.commerce?.error ? ` Erro comércio: ${lead.commerce.error}` : ""}`, "")
      md.push(`**Depois (Exa + Autobound):** ${lead.signalEvents?.length ?? 0} eventos (${(lead.signalEvents ?? []).filter((item) => item.source === "autobound").length} do Autobound).`, "")
      if (lead.signalEvents?.length) {
        md.push("| Tipo | Subtipo do provedor | Data | Fonte | Confiança | Evidência |", "|---|---|---|---|---|---|")
        md.push(...lead.signalEvents.map(eventRow), "")
      } else {
        md.push("Nenhum sinal com evidência encontrado. Nada foi preenchido no lugar.", "")
      }
    }
    tested.push(lead)
    entry.scan = scan
    entry.events = lead.signalEvents ?? []
    entry.beforeExaEvents = before.length
    ;(json.leads as unknown[]).push(entry)
  }

  if (mode === "live" && scoring && !openai) {
    md.push("## Score OpenAI com regra × sem regra", "", "Não executado: OPENAI_API_KEY não encontrada nos arquivos informados.", "")
  }
  if (mode === "live" && scoring && openai) {
    // Brief from the saved run that already holds Productos WOW and Euro Style (LQ professional),
    // with markets widened to the five test countries. Labelled in the report.
    const runs = (seedRuns as unknown as { runs: Run[] }).runs
    const source = runs.find((run) => (run.leads ?? []).some((item) => /WOW|Euro Style/i.test(item.name)))
    const scoringBrief = { ...(source?.brief as Brief), markets: [...new Set(rows.map((row) => row.country))].join(", ") }
    md.push(`## Score OpenAI com regra × sem regra (briefing salvo: ${scoringBrief.supplierName}, mercados ${scoringBrief.markets})`, "")
    try {
      const scored = await scoreLeads(scoringBrief, tested, openai)
      md.push("| Lead | Score do modelo | Pontos de sinais | Com regra | Sem regra | Best fit (inalterado) |", "|---|---|---|---|---|---|")
      const scores: unknown[] = []
      for (const lead of tested) {
        const note = scored.leads.find((item) => item.company.toLowerCase().includes(lead.name.toLowerCase().split(" ")[0]))
        const from = note?.icp
        if (from !== "low" && from !== "medium" && from !== "high") {
          md.push(`| ${lead.name} | sem score | — | — | — | — |`)
          continue
        }
        const withRule = computeUplift(from, lead, "cap_medium_without_buy_fact")
        const noRule = computeUplift(from, lead, "no_cap")
        md.push(`| ${lead.name} | ${from} | +${withRule.points} | ${withRule.to}${withRule.capped ? " (limitado)" : ""} | ${noRule.to} | ${note?.bestFit ?? "—"} |`)
        scores.push({ lead: lead.name, model: from, withRule, noRule, bestFit: note?.bestFit, rationale: note?.rationale })
      }
      json.scores = scores
      md.push("")
    } catch (error) {
      md.push(`Score OpenAI falhou: ${publicError(error, secrets)}`, "")
    }
  }

  md.push(`## Totais`, "")
  md.push(`- Créditos gastos (pior caso): **${budget.spent}** de ${budgetCeiling}`)
  if (mode === "live" && autobound) {
    const after = await freeMetadata("/credits", autobound).catch((error) => ({ ok: false, status: 0, data: publicError(error, secrets) }))
    json.creditsAfter = after
    md.push(`- Saldo depois (\`GET /v1/credits\`): HTTP ${after.status} \`${JSON.stringify(after.data).slice(0, 300)}\``)
  }
  json.creditsSpentWorstCase = budget.spent

  let text = md.join("\n")
  let data = JSON.stringify(json, null, 2)
  for (const secret of secrets) {
    if (secret && secret.length > 6) {
      text = text.split(secret).join("[key]")
      data = data.split(secret).join("[key]")
    }
  }
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = mode === "live" ? "teste-real" : "simulacao"
  fs.writeFileSync(path.join(outDir, `demonstrativo-${stamp}.md`), text)
  fs.writeFileSync(path.join(outDir, `demonstrativo-${stamp}.json`), data)
  console.log(text)
}

if (require.main === module) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
