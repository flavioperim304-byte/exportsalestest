import assert from "node:assert/strict"
import test from "node:test"
import seedRuns from "../lib/data/seed-runs.json"
import { openaiInstructions, parallelInstructions, researchPrompt } from "../lib/prompts"
import { eventsFromExa, normalizeType } from "../lib/signals/events"
import {
  UPLIFT_WEIGHTS,
  applyUplift,
  computeUplift,
  modelIcp,
  qualifyingTypes,
  upliftPoints,
} from "../lib/signals/uplift"
import type { Lead, Run, SignalEvent, SignalType, SignalUpliftRule } from "../lib/types"

// TEST DATA ONLY — synthetic events, not real company signals.
const NOW = Date.parse("2026-11-12T00:00:00Z")
const LEVELS = ["low", "medium", "high"] as const

function event(type: SignalType, overrides: Partial<SignalEvent> = {}): SignalEvent {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    subtype: `test/${type}`,
    occurredAt: "2026-06-01T00:00:00.000Z",
    detectedAt: "2026-11-12T00:00:00.000Z",
    source: "autobound",
    confidence: { level: "high", basis: "test" },
    evidence: { url: `https://example.test/${type}` },
    stageVersion: "test",
    ...overrides,
  }
}

function lead(events: SignalEvent[] = [], icp: "high" | "medium" | "low" = "low"): Lead {
  return {
    id: "l1",
    name: "Example",
    domain: "example.test",
    url: "https://example.test/",
    country: "Colombia",
    exa: { highlights: [], summary: "", text: "" },
    signalEvents: events,
    openai: { icp, supplierFits: [{ supplier: "Kanechom", level: "medium" }], bestFit: "Kanechom", qualificationNeeded: "", rationale: "r" },
  } as unknown as Lead
}

const RULES: SignalUpliftRule[] = ["cap_medium_without_buy_fact", "no_cap"]

test("weights match the user's rule: expansion +2, launch +2, hiring +1, event +1, buyer intent +10, others 0", () => {
  assert.deepEqual(UPLIFT_WEIGHTS, { expansion: 2, product_launch: 2, hiring: 1, event: 1, buyer_intent: 10 })
  for (const type of ["news", "commercial_activity", "other"] as SignalType[]) {
    assert.equal(upliftPoints({ [type]: ["x"] }), 0)
  }
})

test("no signals: the score is kept at every level and under both rules", () => {
  for (const from of LEVELS) {
    for (const rule of RULES) {
      const result = computeUplift(from, lead([]), rule, NOW, false)
      assert.equal(result.to, from)
      assert.equal(result.points, 0)
      assert.equal(result.capped, false)
    }
  }
})

test("signals never lower the score — every type combination, level, rule and buy-fact state", () => {
  const types: SignalType[] = ["hiring", "expansion", "product_launch", "event", "buyer_intent", "news", "commercial_activity", "other"]
  for (let mask = 0; mask < 1 << types.length; mask += 1) {
    const events = types.filter((_, index) => mask & (1 << index)).map((type) => event(type))
    for (const from of LEVELS) {
      for (const rule of RULES) {
        for (const buy of [true, false]) {
          const result = computeUplift(from, lead(events), rule, NOW, buy)
          assert.ok(LEVELS.indexOf(result.to) >= LEVELS.indexOf(from), `${from} → ${result.to} (${rule}, buy=${buy}, mask=${mask})`)
        }
      }
    }
  }
})

test("expansion +2: low reaches high without the cap; the current rule holds it at medium without a buy fact", () => {
  const withRule = computeUplift("low", lead([event("expansion")]), "cap_medium_without_buy_fact", NOW, false)
  assert.equal(withRule.to, "medium")
  assert.equal(withRule.capped, true)
  const noRule = computeUplift("low", lead([event("expansion")]), "no_cap", NOW, false)
  assert.equal(noRule.to, "high")
  const withBuyFact = computeUplift("low", lead([event("expansion")]), "cap_medium_without_buy_fact", NOW, true)
  assert.equal(withBuyFact.to, "high")
})

test("hiring +1 and event +1; each type counts once however many events it has", () => {
  const threeHires = lead([event("hiring"), event("hiring"), event("hiring")])
  assert.equal(computeUplift("low", threeHires, "no_cap", NOW, false).to, "medium")
  assert.equal(computeUplift("medium", threeHires, "no_cap", NOW, false).to, "high")
  assert.equal(computeUplift("low", lead([event("hiring"), event("event")]), "no_cap", NOW, false).points, 2)
})

test("a lead already high stays high under the current rule", () => {
  assert.equal(computeUplift("high", lead([event("hiring")]), "cap_medium_without_buy_fact", NOW, false).to, "high")
})

test("undated, low-confidence, older than 24 months or future events do not count", () => {
  const ignored = [
    event("expansion", { occurredAt: undefined, confidence: { level: "medium", basis: "t" } }),
    event("expansion", { confidence: { level: "low", basis: "t" } }),
    event("expansion", { occurredAt: "2023-01-01T00:00:00.000Z" }),
    event("expansion", { occurredAt: "2027-01-01T00:00:00.000Z" }),
  ]
  assert.deepEqual(qualifyingTypes(lead(ignored), NOW), {})
})

test("negative provider labels never become an increasing type", () => {
  assert.equal(normalizeType("workforce", "layoffs"), "other")
  assert.equal(normalizeType("office", "officeClosing"), "other")
  assert.equal(normalizeType("workforce", "teamContraction"), "other")
  assert.equal(normalizeType("news", "fundingEvent"), "news")
  assert.equal(normalizeType("social", "conferencePresentation"), "event")
  assert.equal(normalizeType("office", "officeOpening"), "expansion")
})

test("Exa fairs and events become the 'event' type", () => {
  const events = eventsFromExa(
    lead([], "low") as Lead & {
      activity: unknown
    },
    "v"
  )
  assert.equal(events.length, 0)
  const withFair = {
    ...lead(),
    activity: { fetchedAt: "x", signals: [{ kind: "exhibition", title: "Feria", url: "https://example.test/feria", publishedAt: "2026-05-01", quote: "" }] },
    commerce: { fetchedAt: "x", signals: [{ kind: "trade_fair", source: "exa", title: "Expo", url: "https://example.test/expo", publishedAt: "2026-05-01", quote: "" }] },
  } as unknown as Lead
  assert.deepEqual(eventsFromExa(withFair, "v").map((item) => item.type), ["event", "event"])
})

test("applyUplift raises ICP only, keeps best_fit and supplier fits, and records the model value", () => {
  const target = lead([event("product_launch")], "low")
  const record = applyUplift(target, "openai", { fresh: true, now: NOW })!
  assert.equal(record.from, "low")
  assert.equal(target.openai!.icp, LEVELS[Math.max(0, LEVELS.indexOf(record.to))])
  assert.equal(target.openai!.bestFit, "Kanechom")
  assert.deepEqual(target.openai!.supplierFits, [{ supplier: "Kanechom", level: "medium" }])
  assert.equal(modelIcp(target, "openai"), "low", "Parallel sees the model's own value")
  const again = applyUplift(target, "openai", { now: NOW })!
  assert.equal(again.from, "low", "re-applying does not stack")
  assert.equal(again.to, record.to)
})

test("a fresh model result is always the base, so a new score is never lowered", () => {
  const target = lead([], "medium")
  target.signalUplift = { openai: { from: "low", to: "high", points: 2, capped: false, rule: "no_cap", hasBuyFact: false, types: {}, version: "v", appliedAt: "x" } }
  target.openai!.icp = "high"
  const record = applyUplift(target, "openai", { fresh: true, now: NOW })!
  assert.equal(record.from, "high")
  assert.equal(target.openai!.icp, "high")
})

test("OpenAI and Parallel receive the signals and the rule; Parallel sees the model's own ICP", () => {
  const runs = (seedRuns as unknown as { runs: Run[] }).runs
  const run = runs.find((item) => item.leads?.length)!
  const target = structuredClone(run.leads[0])
  target.signalEvents = [event("hiring", { evidence: { url: "https://example.test/vaga", title: "Vaga comercial" } })]
  target.openai = { ...(target.openai ?? { supplierFits: [], bestFit: "unknown", qualificationNeeded: "", rationale: "" }), icp: "low" } as Lead["openai"]
  applyUplift(target, "openai", { fresh: true, now: NOW })
  assert.match(openaiInstructions(run.brief), /### SIGNALS/)
  assert.match(parallelInstructions(run.brief), /### SIGNALS/)
  const prompt = researchPrompt(run.brief, [target])
  assert.match(prompt, /detected_signals:\n- contratação · 2026-06-01 · autobound · confidence high · Vaga comercial · https:\/\/example.test\/vaga/)
  assert.match(prompt, /preliminary_openai=ICP low;/)
})

test("saved runs (84 real leads, no stored signals): every score is kept", () => {
  const runs = (seedRuns as unknown as { runs: Run[] }).runs
  let checked = 0
  for (const run of runs) {
    for (const base of run.leads ?? []) {
      for (const source of ["openai", "parallel"] as const) {
        const copy = structuredClone(base)
        const target = source === "openai" ? copy.openai : copy.context
        if (!target?.icp) continue
        const before = target.icp
        for (const rule of RULES) {
          process.env.SIGNAL_UPLIFT_CAP = rule === "no_cap" ? "none" : ""
          applyUplift(copy, source, { fresh: true, now: NOW })
          assert.equal((source === "openai" ? copy.openai : copy.context)!.icp, before)
        }
        checked += 1
      }
    }
  }
  delete process.env.SIGNAL_UPLIFT_CAP
  assert.ok(checked >= 84)
})
