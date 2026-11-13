import assert from "node:assert/strict"
import test from "node:test"
import seedRuns from "../lib/data/seed-runs.json"
import { activityLine } from "../lib/activity"
import { commerceLine } from "../lib/commerce"
import { resultsCsv } from "../lib/csv"
import { computeFitProbability } from "../lib/fit-probability"
import { stampIntelligence } from "../lib/intelligence"
import { toLeadRecord } from "../lib/lead-db"
import { leadAudit, memoryEvents } from "../lib/memory"
import { computeResponseProbability } from "../lib/response-probability"
import { scoreLead } from "../lib/score"
import {
  CreditBudget,
  enrichCompany,
  enrichRequest,
  eventsFromAutobound,
} from "../lib/signals/autobound"
import {
  appendEvents,
  eventId,
  eventsFromExa,
  newSignalEvents,
  normalizeType,
} from "../lib/signals/events"
import { SIGNALS_STAGE_VERSION, applyScan, autoboundKey, creditsSpentInRun, scannedAtVersion } from "../lib/signals/stage"
import type { Lead, Run, SignalScan } from "../lib/types"

// Synthetic fixture shaped like the response example in Autobound's public enrichment guide.
// TEST DATA ONLY — not a real company signal.
const FIXTURE = {
  signals: [
    {
      signal_id: "sig_test_1",
      signal_type: "news",
      signal_subtype: "productLaunch",
      detected_at: "2026-09-01T00:00:00Z",
      data: { url: "https://example.test/news/launch", title: "Example launches a new line", summary: "Test summary." },
    },
    {
      signal_id: "sig_test_2",
      signal_type: "hiring-trends",
      signal_subtype: "departmentGrowth",
      data: { url: "https://example.test/careers", title: "Sales team growth" },
    },
    { signal_id: "sig_test_3", signal_type: "news", signal_subtype: "officeOpening", data: { title: "No URL here" } },
  ],
}

function lead(partial: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    name: "Example Distribuidora",
    domain: "example.test",
    url: "https://example.test/",
    country: "Colombia",
    exa: { highlights: [], summary: "", text: "" },
    ...partial,
  } as unknown as Lead
}

/** Removes clock-only fields (computedAt) so comparisons check content, not wall time. */
function withoutClock<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === "computedAt" ? undefined : item))) as T
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? "" : JSON.stringify(body), { status, headers })
}

test("provider labels map to normalized types without reading article text", () => {
  assert.equal(normalizeType("news", "productLaunch"), "product_launch")
  assert.equal(normalizeType("hiring-trends", "departmentGrowth"), "hiring")
  assert.equal(normalizeType("news", "officeOpening"), "expansion")
  assert.equal(normalizeType("news", "partnership"), "commercial_activity")
  assert.equal(normalizeType("news", "leadershipChange"), "news")
  assert.equal(normalizeType("product-reviews", "g2"), "other")
})

test("Autobound results become events with evidence; no URL means no event", () => {
  const { events, discarded } = eventsFromAutobound(FIXTURE, "example.test", "v-test", "run-1", "2026-11-12T00:00:00.000Z")
  assert.equal(events.length, 2)
  assert.equal(discarded, 1)
  const launch = events.find((event) => event.type === "product_launch")!
  assert.equal(launch.subtype, "news/productLaunch")
  assert.equal(launch.source, "autobound")
  assert.equal(launch.sourceSignalId, "sig_test_1")
  assert.equal(launch.occurredAt, "2026-09-01T00:00:00.000Z")
  assert.equal(launch.detectedAt, "2026-11-12T00:00:00.000Z")
  assert.equal(launch.evidence.url, "https://example.test/news/launch")
  assert.equal(launch.confidence.level, "high")
  assert.equal(launch.stageVersion, "v-test")
  const hiring = events.find((event) => event.type === "hiring")!
  assert.equal(hiring.occurredAt, undefined, "a missing date stays missing")
  assert.equal(hiring.confidence.level, "medium")
})

test("a provider confidence value is kept unchanged", () => {
  const { events } = eventsFromAutobound(
    { signals: [{ signal_type: "news", confidence: 0.42, url: "https://example.test/a", date: "2026-01-02" }] },
    "example.test"
  )
  assert.equal(events[0].confidence.providerValue, 0.42)
})

test("event ids are deterministic and appending never overwrites", () => {
  assert.equal(eventId("autobound", "news", "https://A.test/x", "2026-01-01"), eventId("autobound", "news", "https://a.test/x", "2026-01-01"))
  const target = lead()
  const { events } = eventsFromAutobound(FIXTURE, "example.test")
  assert.equal(appendEvents(target, events), 2)
  const firstDetected = target.signalEvents![0].detectedAt
  const again = eventsFromAutobound(FIXTURE, "example.test", undefined, undefined, "2030-01-01T00:00:00.000Z").events
  assert.equal(appendEvents(target, again), 0)
  assert.equal(target.signalEvents!.length, 2)
  assert.equal(target.signalEvents![0].detectedAt, firstDetected)
})

test("only new events are mirrored to desk_lead_events", () => {
  const before = lead()
  appendEvents(before, eventsFromAutobound(FIXTURE, "example.test").events.slice(0, 1))
  const after = structuredClone(before)
  appendEvents(after, eventsFromAutobound(FIXTURE, "example.test").events)
  assert.equal(newSignalEvents(before, after).length, 1)
  assert.equal(newSignalEvents(undefined, after).length, 2)
})

test("dry run sends nothing and reports the worst-case cost", async () => {
  let calls = 0
  const result = await enrichCompany("https://www.example.test/", {
    budget: new CreditBudget(50),
    dryRun: true,
    limit: 5,
    fetchImpl: (async () => {
      calls += 1
      return response(200, FIXTURE)
    }) as typeof fetch,
  })
  assert.equal(calls, 0)
  assert.equal(result.scan.status, "dry_run")
  assert.equal(result.scan.creditsEstimated, 10)
  assert.equal(result.scan.request?.body.domain, "example.test")
  assert.equal(result.scan.request?.body.limit, 5)
})

test("the budget refuses a call whose worst case does not fit", async () => {
  let calls = 0
  const budget = new CreditBudget(50, 45)
  const result = await enrichCompany("example.test", {
    key: "test-key",
    budget,
    limit: 5,
    fetchImpl: (async () => {
      calls += 1
      return response(200, FIXTURE)
    }) as typeof fetch,
  })
  assert.equal(calls, 0)
  assert.equal(result.scan.status, "skipped_budget")
  assert.equal(result.scan.types.hiring, "skipped_budget")
  assert.equal(budget.spent, 45)
})

test("a live call charges 2 credits per returned signal and records type status", async () => {
  const budget = new CreditBudget(50)
  const result = await enrichCompany("example.test", {
    key: "test-key",
    budget,
    limit: 5,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>)["x-api-key"], "test-key")
      return response(200, FIXTURE, { "x-credits-remaining": "994" })
    }) as unknown as typeof fetch,
  })
  assert.equal(result.scan.status, "done")
  assert.equal(result.scan.creditsEstimated, 6)
  assert.equal(budget.spent, 6)
  assert.deepEqual(result.scan.creditsReported, { "x-credits-remaining": "994" })
  assert.equal(result.scan.types.hiring, "found")
  assert.equal(result.scan.types.expansion, "not_found")
  assert.equal(result.scan.discarded, 1)
  assert.equal(JSON.stringify(result.scan.request).includes("test-key"), false, "the key never goes into the record")
})

test("404 means no signals: nothing charged, types not_found", async () => {
  const budget = new CreditBudget(50)
  const result = await enrichCompany("example.test", {
    key: "k",
    budget,
    fetchImpl: (async () => response(404, { error: "not found" })) as typeof fetch,
  })
  assert.equal(result.scan.status, "done")
  assert.equal(budget.spent, 0)
  assert.equal(result.scan.types.news, "not_found")
})

test("an API error is recorded, releases the reservation and never throws", async () => {
  const budget = new CreditBudget(50)
  const result = await enrichCompany("example.test", {
    key: "k",
    budget,
    fetchImpl: (async () => response(500, { error: "boom" })) as typeof fetch,
  })
  assert.equal(result.scan.status, "error")
  assert.equal(result.scan.types.news, "error")
  assert.equal(budget.spent, 0)
  assert.match(result.scan.error ?? "", /500/)
})

test("filters are sent only when given", () => {
  const plain = enrichRequest("example.test", { now: new Date("2026-11-12T00:00:00Z") })
  assert.equal("signal_types" in plain.body, false)
  assert.equal(plain.body.detected_after, "2024-11-12T00:00:00.000Z")
  const filtered = enrichRequest("example.test", { signalTypes: ["news"] })
  assert.deepEqual(filtered.body.signal_types, ["news"])
})

test("Exa signals become events without touching activity or commerce", () => {
  const target = lead({
    activity: {
      fetchedAt: "2026-11-01T00:00:00Z",
      signals: [{ kind: "launch", title: "Nueva línea", url: "https://news.test/x", publishedAt: "2026-05-01", quote: "q" }],
    },
    commerce: {
      fetchedAt: "2026-11-01T00:00:00Z",
      signals: [
        { kind: "hiring_buy", source: "exa", title: "Buyer job", url: "https://example.test/jobs/1", quote: "q" },
        { kind: "customs", source: "trade_record", title: "Dump line", url: "https://dump.test/1", quote: "q" },
      ],
    },
  })
  const snapshot = JSON.stringify({ a: target.activity, c: target.commerce })
  const events = eventsFromExa(target, "v-test")
  assert.equal(JSON.stringify({ a: target.activity, c: target.commerce }), snapshot)
  assert.equal(events.length, 2, "trade-record lines are not web signals")
  assert.equal(events.find((e) => e.type === "product_launch")?.confidence.level, "low")
  assert.equal(events.find((e) => e.type === "hiring")?.confidence.level, "medium")
})

test("the stage stays off without an Autobound key", () => {
  const saved = process.env.AUTOBOUND_API_KEY
  delete process.env.AUTOBOUND_API_KEY
  try {
    assert.equal(autoboundKey(), undefined)
  } finally {
    if (saved !== undefined) process.env.AUTOBOUND_API_KEY = saved
  }
})

test("scans are versioned and run spend is summed per run", () => {
  const target = lead()
  const scan: SignalScan = {
    stageVersion: SIGNALS_STAGE_VERSION,
    source: "autobound",
    runId: "run-1",
    startedAt: "2026-11-12T00:00:00Z",
    finishedAt: "2026-11-12T00:00:01Z",
    status: "done",
    types: {},
    creditsEstimated: 6,
    eventsAdded: 0,
    discarded: 0,
  }
  applyScan(target, scan, eventsFromAutobound(FIXTURE, "example.test").events)
  assert.equal(scannedAtVersion(target), true)
  assert.equal(scannedAtVersion(target, "signals-autobound@9.9.9"), false)
  assert.equal(target.signalScans![0].eventsAdded, 2)
  assert.equal(creditsSpentInRun({ id: "run-1", leads: [target] } as unknown as Run), 6)
  assert.equal(creditsSpentInRun({ id: "run-2", leads: [target] } as unknown as Run), 0)
})

// Compatibility: adding events must not change any existing output for saved runs.
test("saved runs: existing outputs are identical after signal events are added", () => {
  const runs = (seedRuns as unknown as { runs: Run[] }).runs
  let checked = 0
  for (const original of runs) {
    for (const base of original.leads ?? []) {
      const before = structuredClone(base)
      const after = structuredClone(base)
      applyScan(
        after,
        {
          stageVersion: SIGNALS_STAGE_VERSION,
          source: "autobound",
          runId: original.id,
          startedAt: "2026-11-12T00:00:00Z",
          finishedAt: "2026-11-12T00:00:01Z",
          status: "done",
          types: {},
          creditsEstimated: 6,
          eventsAdded: 0,
          discarded: 0,
        },
        eventsFromAutobound(FIXTURE, after.domain || "example.test").events
      )
      assert.equal(activityLine(after), activityLine(before))
      assert.equal(commerceLine(after), commerceLine(before))
      assert.deepEqual(leadAudit(after), leadAudit(before))
      assert.deepEqual(memoryEvents(leadAudit(before), leadAudit(after), "run"), [])
      assert.deepEqual(scoreLead(original.brief, after), scoreLead(original.brief, before))
      assert.deepEqual(
        withoutClock(computeFitProbability(original.brief, after)),
        withoutClock(computeFitProbability(original.brief, before))
      )
      assert.deepEqual(
        withoutClock(computeResponseProbability(original, after)),
        withoutClock(computeResponseProbability(original, before))
      )
      const recordAfter: Partial<ReturnType<typeof toLeadRecord>> = toLeadRecord(original, after)
      const recordBefore: Partial<ReturnType<typeof toLeadRecord>> = toLeadRecord(original, before)
      delete recordAfter.payload
      delete recordBefore.payload
      assert.deepEqual(withoutClock(recordAfter), withoutClock(recordBefore))
      checked += 1
    }
    const withEvents = structuredClone(original)
    for (const item of withEvents.leads ?? []) appendEvents(item, eventsFromAutobound(FIXTURE, "example.test").events)
    assert.equal(resultsCsv(withEvents), resultsCsv(original), "CSV export unchanged")
    const stampedBefore = structuredClone(original)
    const stampedAfter = structuredClone(withEvents)
    for (const item of stampedBefore.leads ?? []) stampIntelligence(stampedBefore, item)
    for (const item of stampedAfter.leads ?? []) stampIntelligence(stampedAfter, item)
    assert.deepEqual(
      withoutClock((stampedAfter.leads ?? []).map((item) => [item.fit, item.response])),
      withoutClock((stampedBefore.leads ?? []).map((item) => [item.fit, item.response]))
    )
  }
  assert.ok(checked > 0, "at least one saved lead was compared")
})
