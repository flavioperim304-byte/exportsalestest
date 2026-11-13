import { hasPublishedBuyFacts } from "../fit-probability"
import { clip } from "../text"
import type { Lead, SignalEvent, SignalType, SignalUplift, SignalUpliftRule } from "../types"
import { SIGNAL_TYPE_LABEL } from "./events"

export const UPLIFT_VERSION = "signal-uplift@1.1.0"
export const UPLIFT_WINDOW_MONTHS = 24

/**
 * Points per distinct qualifying type (set by the user, 2026-11-12):
 * expansion +2, product launch +2, hiring +1, event +1, buyer intent +10.
 * News, commercial activity and other are neutral. Each type counts once per lead.
 * One point = one ICP level; the result is capped at high (and at medium without a
 * published buy fact while the current rule is on).
 */
export const UPLIFT_WEIGHTS: Partial<Record<SignalType, number>> = {
  expansion: 2,
  product_launch: 2,
  hiring: 1,
  event: 1,
  buyer_intent: 10,
}

const LEVELS = ["low", "medium", "high"] as const
type Level = (typeof LEVELS)[number]

/**
 * cap_medium_without_buy_fact keeps the desk's existing rule: without a published
 * last purchase, stock or sales fact, signals can lift a lead to medium but not high.
 * no_cap lets signals reach high. Default is the existing rule.
 */
export function upliftRule(): SignalUpliftRule {
  return (process.env.SIGNAL_UPLIFT_CAP ?? "").trim().toLowerCase() === "none" ? "no_cap" : "cap_medium_without_buy_fact"
}

function isLevel(value: unknown): value is Level {
  return value === "low" || value === "medium" || value === "high"
}

/** A dated event inside the window with high or medium confidence. Undated events are not counted as recent. */
export function qualifies(event: SignalEvent, now = Date.now()): boolean {
  if (!UPLIFT_WEIGHTS[event.type]) return false
  if (event.confidence.level === "low") return false
  if (!event.occurredAt) return false
  const stamp = Date.parse(event.occurredAt)
  if (!Number.isFinite(stamp) || stamp > now) return false
  const start = new Date(now)
  start.setMonth(start.getMonth() - UPLIFT_WINDOW_MONTHS)
  return stamp >= start.getTime()
}

export function qualifyingTypes(lead: Lead, now = Date.now()): Partial<Record<SignalType, string[]>> {
  const types: Partial<Record<SignalType, string[]>> = {}
  for (const event of lead.signalEvents ?? []) {
    if (!qualifies(event, now)) continue
    ;(types[event.type] ??= []).push(event.id)
  }
  return types
}

export function upliftPoints(types: Partial<Record<SignalType, string[]>>): number {
  return Object.keys(types).reduce((sum, type) => sum + (UPLIFT_WEIGHTS[type as SignalType] ?? 0), 0)
}

/**
 * Pure rule. Never returns a level below `from`. Without qualifying signals, returns `from`.
 */
export function computeUplift(
  from: Level,
  lead: Lead,
  rule: SignalUpliftRule = upliftRule(),
  now = Date.now(),
  hasBuyFact = hasPublishedBuyFacts(lead)
): SignalUplift {
  const types = qualifyingTypes(lead, now)
  const points = upliftPoints(types)
  const start = LEVELS.indexOf(from)
  const raised = Math.min(LEVELS.length - 1, start + points)
  const ceiling = rule === "cap_medium_without_buy_fact" && !hasBuyFact ? LEVELS.indexOf("medium") : LEVELS.length - 1
  const final = Math.max(start, Math.min(raised, ceiling))
  return {
    from,
    to: LEVELS[final],
    points,
    capped: final < raised,
    rule,
    hasBuyFact,
    types,
    version: UPLIFT_VERSION,
    appliedAt: new Date(now).toISOString(),
  }
}

/**
 * Applies the uplift to the model's ICP on the lead. The model's own value is kept in
 * signalUplift[source].from. Idempotent: re-applying starts from the stored model value.
 * best_fit and supplier_fits are never changed.
 */
export function applyUplift(
  lead: Lead,
  source: "openai" | "parallel",
  options: { fresh?: boolean; now?: number } = {}
): SignalUplift | undefined {
  const now = options.now ?? Date.now()
  const target = source === "openai" ? lead.openai : lead.context
  if (!target || !isLevel(target.icp)) return undefined
  // fresh: the model just returned this icp, so it is the base. Otherwise reuse the stored model value.
  const previous = options.fresh ? undefined : lead.signalUplift?.[source]
  const from = previous && previous.to === target.icp ? previous.from : target.icp
  const uplift = computeUplift(from, lead, upliftRule(), now)
  target.icp = uplift.to
  lead.signalUplift = { ...(lead.signalUplift ?? {}), [source]: uplift }
  return uplift
}

/** The model's own ICP, before signals — what Parallel must see, so a signal is never counted twice. */
export function modelIcp(lead: Lead, source: "openai" | "parallel"): string | undefined {
  const target = source === "openai" ? lead.openai : lead.context
  if (!target) return undefined
  const record = lead.signalUplift?.[source]
  return record && record.to === target.icp ? record.from : target.icp
}

/** Card lines for OpenAI and Parallel: the detected signals with date, source, confidence and URL. */
export function signalCardLines(lead: Lead, max = 6): string[] {
  const events = [...(lead.signalEvents ?? [])]
    .filter((event) => event.type !== "other")
    .sort((left, right) => Date.parse(right.occurredAt ?? "") - Date.parse(left.occurredAt ?? "") || 0)
    .slice(0, max)
  return events.map(
    (event) =>
      `- ${SIGNAL_TYPE_LABEL[event.type]} · ${event.occurredAt ? event.occurredAt.slice(0, 10) : "undated"} · ${event.source} · confidence ${event.confidence.level} · ${clip(event.evidence.title || event.subtype, 120)} · ${event.evidence.url}`
  )
}

export const SIGNAL_SCORING_RULE =
  "SIGNALS (detected events: hiring, expansion, product launch, events/fairs, news) are listed per candidate with date, source, confidence and URL. Use them in the rationale and qualification notes. Do NOT raise or lower icp because of these signals and do NOT change best_fit or supplier_fits because of them: the desk applies a fixed, audited signal uplift after scoring. A signal is never purchase evidence, and the absence of signals is never a reason to lower icp."

export function upliftLine(lead: Lead): string {
  const record = lead.signalUplift?.parallel ?? lead.signalUplift?.openai
  if (!record) return ""
  if (record.points === 0) return "Sem sinais qualificados: score mantido."
  const types = Object.keys(record.types)
    .map((type) => SIGNAL_TYPE_LABEL[type as SignalType])
    .join(", ")
  return `Sinais (${types}) somaram +${record.points}: ICP ${record.from} → ${record.to}${record.capped ? " (limitado a medium sem prova publicada de compra)" : ""}.`
}
