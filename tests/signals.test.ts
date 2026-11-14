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
import { appendEvents, eventId, eventsFromExa, newSignalEvents } from "../lib/signals/events"
import { SIGNALS_STAGE_VERSION, applyScan, exaScan, scannedAtVersion } from "../lib/signals/stage"
import type { Lead, Run } from "../lib/types"

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

// TEST DATA ONLY — synthetic Exa activity, not a real company signal.
// Two signals with a URL on the company domain (one dated, one undated) and one without URL.
function fixtureLead(): Lead {
  return lead({
    activity: {
      fetchedAt: "2026-11-01T00:00:00Z",
      signals: [
        { kind: "launch", title: "Example launches a new line", url: "https://example.test/news/launch", publishedAt: "2026-09-01T00:00:00Z", quote: "q" },
        { kind: "exhibition", title: "Example at the fair", url: "https://example.test/fair", quote: "q" },
        { kind: "news", title: "No URL here", url: "", quote: "q" },
      ],
    },
  } as Partial<Lead>)
}

function fixtureEvents(now?: string) {
  return eventsFromExa(fixtureLead(), "v-test", "run-1", now)
}

test("Exa signals with a URL become events; no URL means no event", () => {
  const events = fixtureEvents("2026-11-12T00:00:00.000Z")
  assert.equal(events.length, 2)
  const launch = events.find((event) => event.type === "product_launch")!
  assert.equal(launch.subtype, "activity/launch")
  assert.equal(launch.source, "exa")
  assert.equal(launch.occurredAt, "2026-09-01T00:00:00.000Z")
  assert.equal(launch.detectedAt, "2026-11-12T00:00:00.000Z")
  assert.equal(launch.evidence.url, "https://example.test/news/launch")
  assert.equal(launch.confidence.level, "high")
  assert.equal(launch.stageVersion, "v-test")
  const fair = events.find((event) => event.type === "event")!
  assert.equal(fair.occurredAt, undefined, "a missing date stays missing")
  assert.equal(fair.confidence.level, "medium")
})

test("event ids are deterministic and appending never overwrites", () => {
  assert.equal(eventId("exa", "news", "https://A.test/x", "2026-01-01"), eventId("exa", "news", "https://a.test/x", "2026-01-01"))
  const target = lead()
  assert.equal(appendEvents(target, fixtureEvents()), 2)
  const firstDetected = target.signalEvents![0].detectedAt
  assert.equal(appendEvents(target, fixtureEvents("2030-01-01T00:00:00.000Z")), 0)
  assert.equal(target.signalEvents!.length, 2)
  assert.equal(target.signalEvents![0].detectedAt, firstDetected)
})

test("only new events are mirrored to desk_lead_events", () => {
  const before = lead()
  appendEvents(before, fixtureEvents().slice(0, 1))
  const after = structuredClone(before)
  appendEvents(after, fixtureEvents())
  assert.equal(newSignalEvents(before, after).length, 1)
  assert.equal(newSignalEvents(undefined, after).length, 2)
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

test("the Exa scan reads stored signals only and is versioned per stage", () => {
  const target = fixtureLead()
  const snapshot = JSON.stringify(target.activity)
  const { scan, events } = exaScan(target, "run-1", "2026-11-12T00:00:00.000Z")
  assert.equal(JSON.stringify(target.activity), snapshot)
  assert.equal(scan.source, "exa")
  assert.equal(scan.status, "done")
  assert.equal(scan.stageVersion, SIGNALS_STAGE_VERSION)
  assert.deepEqual(scan.types, { product_launch: "found", event: "found" })
  assert.equal(scannedAtVersion(target), false)
  applyScan(target, scan, events)
  assert.equal(scannedAtVersion(target), true)
  assert.equal(scannedAtVersion(target, "signals-exa@9.9.9"), false)
  assert.equal(target.signalScans![0].eventsAdded, 2)
  applyScan(target, exaScan(target, "run-2").scan, exaScan(target, "run-2").events)
  assert.equal(target.signalEvents!.length, 2, "the same facts are not added twice")
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
          source: "exa",
          runId: original.id,
          startedAt: "2026-11-12T00:00:00Z",
          finishedAt: "2026-11-12T00:00:01Z",
          status: "done",
          types: {},
          eventsAdded: 0,
        },
        fixtureEvents()
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
    for (const item of withEvents.leads ?? []) appendEvents(item, fixtureEvents())
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
