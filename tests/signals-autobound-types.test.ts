import assert from "node:assert/strict"
import test from "node:test"
import { CreditBudget, USER_CONFIRMED_SIGNAL_TYPES, enrichCompany, eventsFromAutobound } from "../lib/signals/autobound"
import { intentEventsFromTimeline, intentTimeline } from "../lib/signals/intent"
import { scannedAtVersion, signalTypesFilter, SIGNALS_STAGE_VERSION } from "../lib/signals/stage"
import { computeUplift, upliftPoints } from "../lib/signals/uplift"
import type { Lead, SignalScan } from "../lib/types"

// TEST DATA ONLY — shaped like the schemas Autobound publishes, values are synthetic.

test("producthunt-launch: evidence comes from product_hunt_url and counts as a product launch", () => {
  const { events, discarded } = eventsFromAutobound(
    {
      signals: [
        {
          signal_id: "ph-1",
          signal_type: "producthunt-launch",
          signal_subtype: "companyProductHuntLaunch",
          detected_at: "2026-06-26T14:30:00Z",
          association: "company",
          data: { product_hunt_url: "https://www.producthunt.com/posts/example", website_url: "https://example.test", votes_count: 10 },
        },
      ],
    },
    "example.test"
  )
  assert.equal(discarded, 0)
  assert.equal(events[0].type, "product_launch")
  assert.equal(events[0].evidence.url, "https://www.producthunt.com/posts/example")
  assert.equal(events[0].occurredAt, "2026-06-26T14:30:00.000Z")
  assert.equal(events[0].subtype, "producthunt-launch/companyProductHuntLaunch")
})

test("linkedin-post-company: provider tags can refine the type; without useful tags it stays neutral", () => {
  const post = (tags?: string[]) => ({
    signal_type: "linkedin-post-company",
    signal_subtype: "linkedinPost",
    signal_name: "Company posted on LinkedIn",
    detected_at: "2026-06-06T19:12:42Z",
    company: { name: "Example" },
    data: { post_url: "https://www.linkedin.com/posts/example-1", ...(tags ? { topic_tags: tags } : {}) },
  })
  const tagged = eventsFromAutobound({ signals: [post(["Product Launch"])] }, "example.test").events[0]
  assert.equal(tagged.type, "product_launch")
  assert.equal(tagged.classifiedBy, "provider_tags")
  assert.deepEqual(tagged.providerTags, ["Product Launch"])
  assert.equal(tagged.evidence.title, "Company posted on LinkedIn", "the company name is not taken as the title")
  assert.equal(eventsFromAutobound({ signals: [post()] }, "example.test").events[0].type, "other")
  assert.equal(eventsFromAutobound({ signals: [post(["Partnership"])] }, "example.test").events[0].type, "other")
  assert.equal(eventsFromAutobound({ signals: [post(["Hiring"])] }, "example.test").events[0].type, "hiring")
  assert.equal(eventsFromAutobound({ signals: [post(["Hiring", "Layoffs"])] }, "example.test").events[0].type, "other")
})

test("website-intelligence: classified by the provider's change subtype", () => {
  const change = (subtype: string) => ({
    signal_type: "website-intelligence",
    signal_subtype: subtype,
    detected_at: "2026-05-01T00:00:00Z",
    data: { page_url: "https://example.test/page" },
  })
  const { events } = eventsFromAutobound({ signals: [change("newProductPage"), change("pricingPageChange")] }, "example.test")
  assert.equal(events.find((item) => item.subtype.endsWith("newProductPage"))?.type, "product_launch")
  assert.equal(events.find((item) => item.subtype.endsWith("pricingPageChange"))?.type, "other")
})

test("the stage asks for the four types confirmed in the dashboard; an env list overrides", () => {
  assert.deepEqual(USER_CONFIRMED_SIGNAL_TYPES, ["news", "producthunt-launch", "website-intelligence", "linkedin-post-company"])
  delete process.env.AUTOBOUND_SIGNAL_TYPES
  assert.deepEqual(signalTypesFilter(), USER_CONFIRMED_SIGNAL_TYPES)
  process.env.AUTOBOUND_SIGNAL_TYPES = "news, hiring-trends"
  assert.deepEqual(signalTypesFilter(), ["news", "hiring-trends"])
  delete process.env.AUTOBOUND_SIGNAL_TYPES
})

test("the enrich request carries the signal_types filter", async () => {
  let sent: Record<string, unknown> = {}
  await enrichCompany("example.test", {
    key: "k",
    budget: new CreditBudget(50),
    signalTypes: USER_CONFIRMED_SIGNAL_TYPES,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ signals: [] }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  assert.deepEqual(sent.signal_types, USER_CONFIRMED_SIGNAL_TYPES)
})

const TIMELINE = {
  domain: "example.test",
  name: "Example",
  topics: [
    {
      topic_id: "b2b_1",
      topic_name: "Hair Care Products",
      weeks: [
        { week: "2026-10-26", composite_score: 41, buying_stage: "awareness" },
        { week: "2026-11-02", composite_score: 63, buying_stage: "consideration" },
      ],
    },
    { topic_id: "b2b_2", topic_name: "Cosmetics Distribution", weeks: [{ week: "2026-11-02", composite_score: 20, buying_stage: "awareness" }] },
  ],
}

test("intent timeline: one event per topic from its latest week, provider score kept, API reference as evidence", () => {
  const endpoint = "https://signals.autobound.ai/v1/buyer-intent/companies/example.test/timeline?topic_ids=b2b_1%2Cb2b_2&weeks=8"
  const events = intentEventsFromTimeline(TIMELINE, "example.test", endpoint)
  assert.equal(events.length, 2)
  const hair = events.find((item) => item.sourceSignalId === "b2b_1")!
  assert.equal(hair.type, "buyer_intent")
  assert.equal(hair.subtype, "buyer-intent/consideration")
  assert.equal(hair.occurredAt, "2026-11-02T00:00:00.000Z")
  assert.equal(hair.confidence.providerValue, 63)
  assert.equal(hair.evidence.url, endpoint)
  assert.match(hair.evidence.quote ?? "", /não é página pública/)
  assert.deepEqual(intentEventsFromTimeline({ domain: "example.test", name: "Example" }, "example.test", endpoint), [], "nothing invented from an empty answer")
})

test("intent: skipped without topics, dry run sends nothing, budget refuses, 404 is not_found", async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response("", { status: 404 })
  }) as typeof fetch
  const none = await intentTimeline("example.test", { key: "k", budget: new CreditBudget(50), topicIds: [], fetchImpl })
  assert.equal(none.scan.status, "skipped_no_topics")
  const dry = await intentTimeline("example.test", { key: "k", budget: new CreditBudget(50), topicIds: ["a", "b"], dryRun: true, fetchImpl })
  assert.equal(dry.scan.status, "dry_run")
  assert.equal(dry.scan.creditsEstimated, 2)
  const broke = await intentTimeline("example.test", { key: "k", budget: new CreditBudget(1), topicIds: ["a", "b"], fetchImpl })
  assert.equal(broke.scan.status, "skipped_budget")
  assert.equal(calls, 0)
  const budget = new CreditBudget(50)
  const missing = await intentTimeline("example.test", { key: "k", budget, topicIds: ["a"], fetchImpl })
  assert.equal(missing.scan.types.buyer_intent, "not_found")
  assert.equal(budget.spent, 0)
  assert.equal(missing.scan.endpoint, "intent_timeline")
})

test("buyer intent weighs +10: it lifts to the highest level the rule allows, and never lowers", () => {
  assert.equal(upliftPoints({ buyer_intent: ["x"] }), 10)
  const lead = {
    signalEvents: intentEventsFromTimeline(TIMELINE, "example.test", "https://signals.autobound.ai/x"),
  } as unknown as Lead
  const now = Date.parse("2026-11-12T00:00:00Z")
  assert.equal(computeUplift("low", lead, "no_cap", now, false).to, "high")
  const capped = computeUplift("low", lead, "cap_medium_without_buy_fact", now, false)
  assert.equal(capped.to, "medium")
  assert.equal(capped.capped, true)
  assert.equal(computeUplift("high", lead, "cap_medium_without_buy_fact", now, false).to, "high")
})

test("enrich and intent scans are tracked separately per stage version", () => {
  const scan = (endpoint?: SignalScan["endpoint"]): SignalScan => ({
    stageVersion: SIGNALS_STAGE_VERSION,
    source: "autobound",
    endpoint,
    startedAt: "x",
    finishedAt: "x",
    status: "done",
    types: {},
    creditsEstimated: 0,
    eventsAdded: 0,
    discarded: 0,
  })
  const lead = { signalScans: [scan("intent_timeline")] } as unknown as Lead
  assert.equal(scannedAtVersion(lead), false)
  assert.equal(scannedAtVersion(lead, SIGNALS_STAGE_VERSION, "intent_timeline"), true)
  lead.signalScans!.push(scan())
  assert.equal(scannedAtVersion(lead), true)
})
