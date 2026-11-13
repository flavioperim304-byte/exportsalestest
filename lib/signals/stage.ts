import fs from "node:fs"
import path from "node:path"
import type { Lead, Run, SignalScan } from "../types"
import { getRun, updateRun } from "../store"
import {
  AUTOBOUND_STAGE_VERSION,
  CreditBudget,
  DEFAULT_RUN_BUDGET,
  DEFAULT_SIGNAL_LIMIT,
  USER_CONFIRMED_SIGNAL_TYPES,
  enrichCompany,
} from "./autobound"
import { appendEvents, eventsFromExa } from "./events"
import { intentTimeline, intentTopics } from "./intent"

/** The stage is versioned: a lead is processed once per stage version. */
export const SIGNALS_STAGE_VERSION = AUTOBOUND_STAGE_VERSION

/**
 * Reads AUTOBOUND_API_KEY from the environment, or from api-keys.env at the project root
 * (the same file the desk already uses for its other keys). keys.ts is not modified.
 */
export function autoboundKey(): string | undefined {
  const fromEnv = (process.env.AUTOBOUND_API_KEY ?? "").trim()
  if (fromEnv) return fromEnv
  try {
    const text = fs.readFileSync(path.join(process.cwd(), "api-keys.env"), "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("AUTOBOUND_API_KEY")) continue
      const value = trimmed.slice(trimmed.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")
      if (value) return value
    }
  } catch {
    // no file: stage stays off
  }
  return undefined
}

export function runBudgetCeiling(): number {
  const raw = Number(process.env.AUTOBOUND_MAX_CREDITS_PER_RUN)
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RUN_BUDGET
}

export function signalLimit(): number {
  const raw = Number(process.env.AUTOBOUND_SIGNALS_PER_COMPANY)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SIGNAL_LIMIT
}

/** Provider signal_types filter. AUTOBOUND_SIGNAL_TYPES (comma list) overrides the user-confirmed default. */
export function signalTypesFilter(): string[] {
  const raw = (process.env.AUTOBOUND_SIGNAL_TYPES ?? "").split(",").map((item) => item.trim()).filter(Boolean)
  return raw.length ? raw : [...USER_CONFIRMED_SIGNAL_TYPES]
}

export function scannedAtVersion(
  lead: Lead,
  version = SIGNALS_STAGE_VERSION,
  endpoint: "enrich" | "intent_timeline" = "enrich"
): boolean {
  return (lead.signalScans ?? []).some(
    (scan) => scan.stageVersion === version && scan.source === "autobound" && (scan.endpoint ?? "enrich") === endpoint
  )
}

function needsScan(lead: Lead, topics: string[]): boolean {
  return !scannedAtVersion(lead) || (topics.length > 0 && !scannedAtVersion(lead, SIGNALS_STAGE_VERSION, "intent_timeline"))
}

/** Credits already charged to this run by this stage (worst-case accounting). */
export function creditsSpentInRun(run: Run): number {
  let total = 0
  for (const lead of run.leads) {
    for (const scan of lead.signalScans ?? []) {
      if (scan.runId === run.id && scan.source === "autobound") total += scan.creditsEstimated || 0
    }
  }
  return total
}

/** Applies one scan to a lead: appends events (never overwrites) and records the execution. */
export function applyScan(lead: Lead, scan: SignalScan, events: Parameters<typeof appendEvents>[1]): SignalScan {
  const exa = eventsFromExa(lead, SIGNALS_STAGE_VERSION, scan.runId, scan.finishedAt)
  const added = appendEvents(lead, [...events, ...exa])
  const recorded: SignalScan = { ...scan, eventsAdded: added }
  lead.signalScans = [...(lead.signalScans ?? []), recorded]
  return recorded
}

function logLine(run: Run, message: string) {
  run.logs.push({ at: new Date().toISOString(), stage: "classify", message })
  if (run.logs.length > 80) run.logs.splice(0, run.logs.length - 80)
}

/**
 * Separate, versioned signals step. Processes one lead per call (like the activity step)
 * and returns "wait" while leads remain. Without AUTOBOUND_API_KEY it returns "ready"
 * immediately and touches nothing, so the current flow is unchanged.
 */
export async function attachMissingSignals(id: string): Promise<"wait" | "ready"> {
  const key = autoboundKey()
  if (!key) return "ready"
  const snapshot = await getRun(id)
  if (!snapshot || snapshot.mode === "sample") return "ready"
  const topics = intentTopics()
  const pending = snapshot.leads.find((lead) => needsScan(lead, topics))
  if (!pending) return "ready"

  const budget = new CreditBudget(runBudgetCeiling(), creditsSpentInRun(snapshot))
  const doEnrich = !scannedAtVersion(pending)
  const result = doEnrich
    ? await enrichCompany(pending.domain || pending.url, {
        key,
        budget,
        limit: signalLimit(),
        signalTypes: signalTypesFilter(),
        runId: snapshot.id,
      })
    : undefined
  // Buyer intent only runs when topic ids are configured (AUTOBOUND_INTENT_TOPICS).
  const intent =
    topics.length && !scannedAtVersion(pending, SIGNALS_STAGE_VERSION, "intent_timeline")
      ? await intentTimeline(pending.domain || pending.url, { key, budget, topicIds: topics, runId: snapshot.id })
      : undefined

  await updateRun(id, (run) => {
    const lead = run.leads.find((item) => item.id === pending.id)
    if (!lead) return
    if (intent && !scannedAtVersion(lead, SIGNALS_STAGE_VERSION, "intent_timeline")) {
      const recorded = applyScan(lead, intent.scan, intent.events)
      logLine(run, `Intenção de compra Autobound para ${lead.name}: ${recorded.status === "done" ? `${intent.events.length} tópico(s) com dado` : recorded.error ?? recorded.status}.`)
    }
    if (!result || scannedAtVersion(lead)) return
    const scan = applyScan(lead, result.scan, result.events)
    const found = result.events.length
    logLine(
      run,
      scan.status === "done"
        ? `Sinais Autobound (${SIGNALS_STAGE_VERSION}) para ${lead.name}: ${found} ${found === 1 ? "evento" : "eventos"} com evidência${scan.discarded ? `, ${scan.discarded} sem URL descartados` : ""}.`
        : scan.status === "skipped_budget"
          ? `Sinais Autobound pulados para ${lead.name}: teto de créditos da execução atingido.`
          : `Sinais Autobound não coletados para ${lead.name}. ${scan.error ?? scan.status}`
    )
  })
  return "wait"
}
