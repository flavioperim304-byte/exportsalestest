import type { Lead, SignalEvent, SignalScan, SignalType, SignalTypeStatus } from "../types"
import { getRun, updateRun } from "../store"
import { appendEvents, eventsFromExa } from "./events"

/** The stage is versioned: a lead is processed once per stage version. */
export const SIGNALS_STAGE_VERSION = "signals-exa@1.0.0"

export function scannedAtVersion(lead: Lead, version = SIGNALS_STAGE_VERSION): boolean {
  return (lead.signalScans ?? []).some((scan) => scan.stageVersion === version && scan.source === "exa")
}

/** Applies one scan to a lead: appends events (never overwrites) and records the execution. */
export function applyScan(lead: Lead, scan: SignalScan, events: SignalEvent[]): SignalScan {
  const added = appendEvents(lead, events)
  const recorded: SignalScan = { ...scan, eventsAdded: added }
  lead.signalScans = [...(lead.signalScans ?? []), recorded]
  return recorded
}

/**
 * Builds the Exa scan for one lead from what the Exa activity and commerce steps already stored.
 * No API call: it only reads lead.activity / lead.commerce.
 */
export function exaScan(lead: Lead, runId?: string, now = new Date().toISOString()): { scan: SignalScan; events: SignalEvent[] } {
  const events = eventsFromExa(lead, SIGNALS_STAGE_VERSION, runId, now)
  const types: Partial<Record<SignalType, SignalTypeStatus>> = {}
  for (const event of events) types[event.type] = "found"
  return {
    events,
    scan: {
      stageVersion: SIGNALS_STAGE_VERSION,
      source: "exa",
      runId,
      startedAt: now,
      finishedAt: now,
      status: "done",
      types,
      eventsAdded: 0,
    },
  }
}

/**
 * Separate, versioned signals step. Runs after the Exa activity and commerce steps and turns
 * their stored signals into events. Sample runs are untouched.
 */
export async function attachMissingSignals(id: string): Promise<"wait" | "ready"> {
  const snapshot = await getRun(id)
  if (!snapshot || snapshot.mode === "sample") return "ready"
  if (!snapshot.leads.some((lead) => !scannedAtVersion(lead))) return "ready"

  await updateRun(id, (run) => {
    let leads = 0
    let added = 0
    for (const lead of run.leads) {
      if (scannedAtVersion(lead)) continue
      const { scan, events } = exaScan(lead, run.id)
      added += applyScan(lead, scan, events).eventsAdded
      leads += 1
    }
    run.logs.push({
      at: new Date().toISOString(),
      stage: "classify",
      message: `Sinais Exa (${SIGNALS_STAGE_VERSION}): ${leads} lead(s) processada(s), ${added} ${added === 1 ? "evento" : "eventos"} com URL.`,
    })
    if (run.logs.length > 80) run.logs.splice(0, run.logs.length - 80)
  })
  return "ready"
}
