import { emptyActivity, searchActivity } from "./activity"
import { emptyCommerce, searchCommerce } from "./commerce"
import { attachMissingSignals } from "./signals/stage"
import { applyUplift } from "./signals/uplift"
import { applyFilingToLead } from "./trade-records"
import { listFilings } from "./trade-store"
import {
  brandKindOf,
  buildReport,
  classifyBlocks,
  coverageGaps,
  failedProbe,
  hitsFromSearch,
  latestReport,
  probeFromSearch,
} from "./diligence"
import { stampIntelligence } from "./intelligence"
import { brazilExports, countriesForTrade, tradeCooldownActive } from "./comexstat"
import { matchLeads, ragConfigured, ragNeedsRetry, ragNotConfiguredMatch } from "./rag"
import { apiConfirmNote, dumpCountries, firecrawlConfirms } from "./confirm"
import { shouldClassifyLead } from "./dump-signal"
import { searchDumpFlow } from "./dump-search"
import { advanceExa, searchLeads } from "./exa"
import {
  EXTRACT_POLL_MS,
  failedExtraction,
  jobTimedOut,
  pollExtractJob,
  scrapeProfile,
  stageTimedOut,
  startExtractJob,
  timedOutExtraction,
} from "./firecrawl"
import { publicError } from "./http"
import { getKeys } from "./keys"
import { draftDiligence, scoreLeads } from "./openai"
import {
  createResearch,
  decideResearch,
  namesMatch,
  researchResult,
  researchStatus,
} from "./parallel"
import { localizeCompetitors } from "./competitors"
import { compareLeads } from "./score"
import { requestJson } from "./http"
import { getRun, insertRun, listRuns, updateRun } from "./store"
import type { Brief, DiligenceProbe, Extraction, Lead, LogLine, Run, StageId, StageState, TradeSnapshot } from "./types"
import { SAMPLE_RUN_ID } from "./ids"

const running = new Set<string>()
const RESEARCH_BUDGET_MS = 8 * 60 * 1000

function now(): string {
  return new Date().toISOString()
}

function stage(run: Run, id: StageId): StageState {
  const found = run.stages.find((item) => item.id === id)
  if (!found) throw new Error(`Missing stage ${id}`)
  return found
}

function log(run: Run, stageId: LogLine["stage"], message: string) {
  run.logs.push({ at: now(), stage: stageId, message })
  if (run.logs.length > 80) run.logs.splice(0, run.logs.length - 80)
}

function secrets(): string[] {
  const keys = getKeys()
  return [keys.exa, keys.firecrawl, keys.openai, keys.parallel].filter((item): item is string =>
    Boolean(item)
  )
}

export function blankStages(kind?: Brief["searchKind"]): StageState[] {
  const searchDetail =
    kind === "dump"
      ? "Dump names go to Exa. Company Atlas can confirm a customs line in overlapping markets. Firecrawl reads the page. The dump never confirms a purchase."
      : kind === "competitors"
        ? "Exa is mapping the brand’s distributors and direct competitor importers."
        : "Exa Agent is in search mode, asking for 10 companies in each target country."
  return [
    {
      id: "search",
      status: "running",
      detail: searchDetail,
      startedAt: now(),
    },
    {
      id: "extract",
      status: "pending",
      detail: "Waiting for Firecrawl to scrape and crawl the company site and the web for contacts.",
    },
    {
      id: "classify",
      status: "pending",
      detail: "Waiting for Exa to collect news, launches, and social activity, then OpenAI scores fit.",
    },
    {
      id: "context",
      status: "pending",
      detail: "Waiting for Parallel to refine that score and research the market.",
    },
    {
      id: "diligence",
      status: "pending",
      detail: "Commercial due diligence waits until you select companies and a brand.",
    },
  ]
}

export function createRun(brief: Brief, also?: Brief): Run {
  const timestamp = now()
  const names = also ? `${brief.supplierName} and ${also.supplierName}` : brief.supplierName
  const startNote =
    brief.searchKind === "dump"
      ? `Qualification started for ${names}. Dump names seed the list. Company Atlas can match HS lines in 36 markets. Exa and Firecrawl confirm or reject the company website. Then Exa searches similar importers. Logistics and global brands stay out. The dump never confirms a purchase.`
      : `Qualification started for ${names}. Exa searches, Firecrawl collects contacts, OpenAI scores, and Parallel refines the best fit.`
  return {
    id: crypto.randomUUID(),
    createdAt: timestamp,
    updatedAt: timestamp,
    mode: "live",
    status: "searching",
    brief,
    also,
    stages: blankStages(brief.searchKind),
    logs: [
      {
        at: timestamp,
        stage: "search",
        message: startNote,
      },
    ],
    leads: [],
    competitors: [],
    contextState: "pending",
  }
}

function applyResearch(
  run: Run,
  parsed: NonNullable<Awaited<ReturnType<typeof researchResult>>>
) {
  run.market = parsed.market
  run.competitors = localizeCompetitors(parsed.competitors, run.brief)
  const unmatched: string[] = []
  for (const note of parsed.leads) {
    const lead = run.leads.find(
      (item) => namesMatch(item.name, note.company) || namesMatch(item.domain, note.company)
    )
    if (!lead) {
      unmatched.push(note.company)
      continue
    }
    lead.context = {
      fitNarrative: note.fitNarrative,
      knownSuppliers: note.knownSuppliers,
      risks: note.risks,
      citations: note.citations,
      icp: note.icp,
      supplierFits: note.supplierFits,
      bestFit: note.bestFit,
      qualificationNeeded: note.qualificationNeeded,
    }
    // Signal uplift on Parallel's ICP: never lowers it; best_fit is untouched.
    applyUplift(lead, "parallel", { fresh: true })
  }
  if (unmatched.length) {
    log(
      run,
      "context",
      `Parallel returned notes that did not match a lead: ${unmatched.join(", ")}.`
    )
  }
  const context = stage(run, "context")
  context.status = "done"
  context.finishedAt = now()
  context.detail = `Best fit attached for ${parsed.leads.length} names. ${parsed.competitors.length} competitor suppliers.`
  run.contextState = "done"
  log(run, "context", context.detail)
}

function tradeCountries(run: Run): string[] {
  return countriesForTrade(
    run.brief.markets,
    run.leads.map((lead) => lead.market || lead.country)
  )
}

function tradeIsCurrent(trade: TradeSnapshot | undefined, countries: string[]): boolean {
  if (!trade || trade.error) return false
  const have = new Set(trade.countries.map((item) => item.country.toLowerCase()))
  return countries.every((country) =>
    [...have].some((item) => item === country.toLowerCase() || item.includes(country.toLowerCase()))
  )
}

function tradeRetryDue(run: Run): boolean {
  const hs = run.brief.hsCode?.trim()
  if (!hs) return false
  const countries = tradeCountries(run)
  if (countries.length === 0) return false
  if (tradeIsCurrent(run.trade, countries)) return false
  return !tradeCooldownActive(run.trade)
}

const tradeBusy = new Set<string>()

async function attachCustomsRecords(id: string, force = false) {
  const records = await listFilings()
  if (records.length === 0) return
  await updateRun(id, (run) => {
    let hits = 0
    let checked = 0
    for (const lead of run.leads) {
      if (!force && lead.filingChecked) continue
      applyFilingToLead(lead, records, run.brief)
      stampIntelligence(run, lead)
      checked += 1
      if (lead.filing) hits += 1
    }
    if (checked) {
      log(
        run,
        "classify",
        hits
          ? `Trade filings matched ${hits} of ${checked} companies.`
          : `Trade filings checked ${checked} companies. None matched a stored importer.`
      )
    }
  })
}

export async function rematchFilingsOnRuns(): Promise<number> {
  const runs = await listRuns()
  let touched = 0
  for (const run of runs) {
    if (run.mode === "sample") continue
    await attachCustomsRecords(run.id, true)
    touched += 1
  }
  return touched
}

async function attachTrade(id: string) {
  if (tradeBusy.has(id)) return
  const run = await getRun(id)
  if (!run) return
  if (!tradeRetryDue(run)) return
  tradeBusy.add(id)
  try {
    const snapshot = await brazilExports(run.brief.hsCode!.trim(), tradeCountries(run))
    await updateRun(id, (current) => {
      current.trade = snapshot
      const ok = snapshot.countries.filter((item) => !item.error).length
      log(
        current,
        "system",
        snapshot.error
          ? `Comex Stat: ${snapshot.error}`
          : `Comex Stat export volume attached for HS ${snapshot.hsCode} in ${ok} ${ok === 1 ? "country" : "countries"}.`
      )
    })
  } finally {
    tradeBusy.delete(id)
  }
}

function fitRank(lead: Lead): number {
  const level = lead.context?.icp || lead.openai?.icp
  if (level === "high") return 3
  if (level === "medium") return 2
  if (level === "low") return 1
  return 0
}

function fileChecklist(run: Run) {
  for (const lead of run.leads) {
    stampIntelligence(run, lead)
  }
  run.leads.sort((left, right) => fitRank(right) - fitRank(left) || compareLeads(left, right))
}

function finish(run: Run) {
  fileChecklist(run)
  run.status = "complete"
  run.error = undefined
  const parallel = run.leads.filter((lead) => lead.context?.icp).length
  const openai = run.leads.filter((lead) => lead.openai).length
  log(
    run,
    "system",
    parallel
      ? `Parallel set the final best fit on ${parallel} of ${run.leads.length} companies.`
      : openai
        ? `OpenAI’s preliminary best fit is still the one on the desk. Parallel did not replace it.`
        : `No model score is attached. The table is the evidence checklist.`
  )
}

function searchCounts(leads: Lead[]): string {
  const byCountry = new Map<string, number>()
  for (const lead of leads) {
    const country = lead.market || "Unassigned"
    byCountry.set(country, (byCountry.get(country) ?? 0) + 1)
  }
  return [...byCountry.entries()].map(([country, count]) => `${country}: ${count}`).join(" · ")
}

function beginExtract(run: Run, detail: string) {
  run.status = "extracting"
  const search = stage(run, "search")
  search.status = "done"
  search.finishedAt = now()
  search.detail = detail
  log(run, "search", detail)
  const extract = stage(run, "extract")
  extract.status = "running"
  extract.startedAt = now()
  extract.detail = "Reading the first company page."
}

async function fileOpenSearch(id: string, found: { leads: Lead[]; outside: number }) {
  const leads = found.leads
  await updateRun(id, (current) => {
    if (leads.length === 0) {
      current.status = "failed"
      current.error =
        found.outside > 0
          ? `Exa suggested ${found.outside} ${found.outside === 1 ? "company" : "companies"} from another country or another supplier. None were in ${current.brief.markets}.`
          : "Exa returned no company pages after the supplier’s own domain was removed. Broaden the products or the markets and run again."
      const search = stage(current, "search")
      search.status = "failed"
      search.detail = current.error
      search.finishedAt = now()
      log(current, "search", current.error)
      return
    }
    current.leads = leads
    const counts = searchCounts(leads)
    beginExtract(current, `Exa Agent search returned ${leads.length} companies. ${counts}.`)
  })
}

async function runDumpSearch(id: string, key: string) {
  const snapshot = await getRun(id)
  if (!snapshot) return
  await updateRun(id, (run) => {
    const search = stage(run, "search")
    search.detail = "Exa is confirming dump names. Company Atlas checks overlapping markets when connected. Firecrawl confirms the page later. The dump does not confirm a purchase."
    log(run, "search", search.detail)
  })
  const filings = await listFilings()
  const found = await searchDumpFlow(snapshot.brief, key, filings, snapshot.also)
  await updateRun(id, (current) => {
    current.rejectedSeeds = found.rejected
    if (found.leads.length === 0) {
      const available = dumpCountries(filings)
      const sample = found.rejected
        .slice(0, 4)
        .map((row) => `${row.importer}: ${row.reason}`)
        .join(" ")
      current.status = "failed"
      current.error =
        found.candidates === 0
          ? `Nenhum candidato no dump para ${current.brief.markets || "estes mercados"}. Cole austsham, jap, hk, uz, ger ou UAE em Aduana e coloque esses países em Target markets.${available.length ? ` Arquivo atual: ${available.join(", ")}.` : ""} Logística e marcas globais já ficam de fora.`
          : `Exa não confirmou nenhum importador do dump (${found.candidates} nomes). ${sample}`.trim()
      const search = stage(current, "search")
      search.status = "failed"
      search.detail = current.error
      search.finishedAt = now()
      log(current, "search", current.error)
      return
    }
    current.leads = found.leads
    const rejected = found.rejected.length
    beginExtract(
      current,
      `Exa confirmou ${found.confirmed} de ${found.candidates} nomes do dump. ${found.similar} concorrentes similares.${rejected ? ` ${rejected} descartados.` : ""} ${searchCounts(found.leads)}.`
    )
    if (found.atlasNote) {
      log(current, "search", found.atlasNote)
    }
    if (rejected) {
      log(
        current,
        "search",
        `APIs descartaram ${rejected} nomes do dump: ${found.rejected
          .slice(0, 8)
          .map((row) => row.importer)
          .join(", ")}.`
      )
    }
  })
}

const activeSearches = new Set<string>()

async function doSearch(id: string): Promise<"busy" | "done"> {
  const keys = getKeys()
  const claimed = await updateRun(id, (run) => {
    if (run.status === "failed" || run.status === "complete") return "stop" as const
    if (run.leads.length > 0) return "resume" as const
    if (run.searchClaimed) return "busy" as const
    run.searchClaimed = true
    run.status = "searching"
    const search = stage(run, "search")
    search.status = "running"
    search.startedAt = search.startedAt ?? now()
    return "go" as const
  })
  if (claimed !== "go") {
    if (claimed === "busy") {
      if (activeSearches.has(id)) return "busy"
      await updateRun(id, (run) => {
        if (run.status === "searching") run.searchClaimed = false
      })
      return "done"
    }
    if (claimed === "resume") {
      await updateRun(id, (run) => {
        if (run.status === "searching") run.status = "extracting"
        const search = stage(run, "search")
        if (search.status === "running") {
          search.status = "done"
          search.finishedAt = now()
        }
      })
    }
    return "done"
  }
  if (!keys.exa) {
    await updateRun(id, (run) => {
      run.status = "failed"
      run.error = "Add an Exa API key under Sources, then start a new qualification."
      const search = stage(run, "search")
      search.status = "failed"
      search.detail = run.error
      search.finishedAt = now()
      log(run, "search", run.error ?? "Exa key missing.")
    })
    return "done"
  }
  activeSearches.add(id)
  try {
    const run = await getRun(id)
    if (!run) return "done"
    if (run.brief.searchKind === "dump") {
      await runDumpSearch(id, keys.exa)
    } else {
      const found = await searchLeads(run.brief, keys.exa, run.also)
      await fileOpenSearch(id, found)
    }
    void attachTrade(id)
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (run) => {
      run.status = "failed"
      run.error = message
      run.searchClaimed = false
      const search = stage(run, "search")
      search.status = "failed"
      search.detail = message
      search.finishedAt = now()
      log(run, "search", message)
    })
  } finally {
    activeSearches.delete(id)
  }
  return "done"
}

function finishExtractStage(run: Run, detail?: string) {
  const extract = stage(run, "extract")
  extract.status = "done"
  extract.finishedAt = now()
  const failed = run.leads.filter((lead) => lead.extraction && !lead.extraction.ok).length
  const confirmed = run.leads.filter((lead) => lead.apiConfirm?.firecrawl === "confirmed").length
  const dumpRun = run.brief.searchKind === "dump"
  extract.detail =
    detail ??
    (dumpRun
      ? `Firecrawl confirmou ${confirmed} de ${run.leads.length} páginas.${failed ? ` ${failed} sem leitura.` : ""} O dump não confirma compra.`
      : failed > 0
        ? `Pages read. ${failed} ${failed === 1 ? "page" : "pages"} could not be extracted.`
        : `Firecrawl scraped and crawled contacts for ${run.leads.length} companies.`)
  run.extractJobId = undefined
  run.extractLeadId = undefined
  run.extractJobStartedAt = undefined
  run.status = "scoring"
  log(run, "extract", extract.detail)
}

function stampFirecrawl(lead: Lead) {
  if (!lead.apiConfirm && lead.seed !== "dump" && lead.seed !== "similar") return
  const confirm = firecrawlConfirms(lead.extraction)
  lead.apiConfirm = {
    exa: lead.apiConfirm?.exa ?? "confirmed",
    firecrawl: confirm.status,
    note: apiConfirmNote({
      exa: lead.apiConfirm?.exa ?? "confirmed",
      firecrawl: confirm.status,
      note: [confirm.reason, lead.atlas?.status === "hit" ? lead.atlas.note : ""].filter(Boolean).join(" "),
    }),
  }
}

function fileExtraction(run: Run, leadId: string, extraction: Extraction) {
  const lead = run.leads.find((item) => item.id === leadId)
  if (!lead) return
  if (!extraction.buyerSignals.length && lead.exa.highlights.length) {
    extraction.buyerSignals = lead.exa.highlights.slice(0, 4)
  }
  lead.extraction = extraction
  if (!lead.country && extraction.country) lead.country = extraction.country
  stampFirecrawl(lead)
  run.extractJobId = undefined
  run.extractLeadId = undefined
  run.extractJobStartedAt = undefined
  const api =
    lead.apiConfirm?.firecrawl === "confirmed"
      ? " Firecrawl confirmou."
      : lead.apiConfirm?.firecrawl === "rejected"
        ? " Firecrawl não confirmou."
        : ""
  log(
    run,
    "extract",
    extraction.ok
      ? `Extracted ${lead.name}: ${extraction.role || "role unpublished"}.${api}`
      : `Could not extract ${lead.name}. ${extraction.error ?? "Unknown page error."}${api}`
  )
}

function skipUnreadPages(run: Run, message: string) {
  for (const lead of run.leads) {
    if (!lead.extraction) lead.extraction = failedExtraction(message)
    stampFirecrawl(lead)
  }
  finishExtractStage(run, `${message} OpenAI will score the pages already read.`)
}

async function doExtract(id: string): Promise<"wait" | "next"> {
  const keys = getKeys()
  const snapshot = await getRun(id)
  if (!snapshot) return "next"

  if (!keys.firecrawl) {
    await updateRun(id, (run) => {
      for (const lead of run.leads) {
        if (lead.seed === "dump" || lead.seed === "similar" || lead.apiConfirm) {
          lead.apiConfirm = {
            exa: lead.apiConfirm?.exa ?? "confirmed",
            firecrawl: "skipped",
            note: [
              "Firecrawl key missing. Só o Exa confirmou o nome. O dump não confirma compra.",
              lead.atlas?.status === "hit" ? lead.atlas.note : "",
            ]
              .filter(Boolean)
              .join(" "),
          }
        }
      }
      const extract = stage(run, "extract")
      extract.status = "blocked"
      extract.finishedAt = now()
      extract.detail =
        run.brief.searchKind === "dump"
          ? "Firecrawl API key is missing. Exa confirmed names stay unconfirmed by the page. The dump does not confirm a purchase."
          : "Firecrawl API key is missing. OpenAI will score the Exa search notes only."
      log(run, "extract", extract.detail)
      run.status = "scoring"
    })
    return "next"
  }

  const extractStarted = stage(snapshot, "extract").startedAt
  if (stageTimedOut(extractStarted)) {
    await updateRun(id, (run) => {
      skipUnreadPages(run, "Firecrawl stage timed out after 8 minutes.")
    })
    return "next"
  }

  if (snapshot.extractLeadId) {
    const lead = snapshot.leads.find((item) => item.id === snapshot.extractLeadId)
    if (!lead) {
      await updateRun(id, (run) => {
        run.extractJobId = undefined
        run.extractLeadId = undefined
        run.extractJobStartedAt = undefined
      })
      return "next"
    }

    if (!snapshot.extractJobStartedAt) {
      await updateRun(id, (run) => {
        run.extractJobStartedAt = now()
      })
    }
    const timedOut = jobTimedOut(snapshot.extractJobStartedAt ?? now())
    if (snapshot.extractJobId && !timedOut) {
      try {
        const polled = await pollExtractJob(keys.firecrawl, snapshot.extractJobId, lead.url)
        if (polled.pending) {
          await updateRun(id, (run) => {
            const extract = stage(run, "extract")
            const index = run.leads.findIndex((item) => item.id === lead.id) + 1
            const waited = snapshot.extractJobStartedAt
              ? Math.max(0, Math.round((Date.now() - Date.parse(snapshot.extractJobStartedAt)) / 1000))
              : 0
            extract.detail = `Reading ${lead.name} (${index} of ${run.leads.length})${waited ? ` · ${waited}s` : ""}.`
          })
          return "wait"
        }
        await updateRun(id, (run) => fileExtraction(run, lead.id, polled.extraction))
        return "next"
      } catch (error) {
        if (!timedOut) {
          const message = publicError(error, secrets())
          await updateRun(id, (run) => fileExtraction(run, lead.id, failedExtraction(message)))
          return "next"
        }
      }
    }

    if (timedOut || !snapshot.extractJobId) {
      if (timedOut) {
        const scraped = await scrapeProfile(
          lead.url,
          snapshot.brief,
          keys.firecrawl,
          lead.market ?? "",
          lead.buyerType ?? ""
        )
        await updateRun(id, (run) =>
          fileExtraction(run, lead.id, scraped.ok ? scraped : timedOutExtraction())
        )
        return "next"
      }
    }
  }

  const pending = snapshot.leads.find((lead) => !lead.extraction)
  if (!pending) {
    await updateRun(id, (run) => finishExtractStage(run))
    return "next"
  }

  if (!/^https?:\/\//i.test(pending.url)) {
    await updateRun(id, (run) => fileExtraction(run, pending.id, failedExtraction("The lead has no http(s) page to read.")))
    return "next"
  }

  await updateRun(id, (run) => {
    run.extractLeadId = pending.id
    run.extractJobStartedAt = now()
    const extract = stage(run, "extract")
    extract.status = "running"
    extract.startedAt = extract.startedAt ?? now()
    const index = run.leads.findIndex((item) => item.id === pending.id) + 1
    extract.detail = `Reading ${pending.name} (${index} of ${run.leads.length}).`
  })

  try {
    const jobId = await startExtractJob(
      pending.url,
      snapshot.brief,
      keys.firecrawl,
      pending.market ?? "",
      pending.buyerType ?? ""
    )
    await updateRun(id, (run) => {
      run.extractJobId = jobId
      run.extractLeadId = pending.id
      run.extractJobStartedAt = run.extractJobStartedAt ?? now()
    })
  } catch (error) {
    const message = publicError(error, secrets())
    try {
      const scraped = await scrapeProfile(
        pending.url,
        snapshot.brief,
        keys.firecrawl,
        pending.market ?? "",
        pending.buyerType ?? ""
      )
      await updateRun(id, (run) =>
        fileExtraction(run, pending.id, scraped.ok ? scraped : failedExtraction(message))
      )
    } catch {
      await updateRun(id, (run) => fileExtraction(run, pending.id, failedExtraction(message)))
    }
  }
  return "next"
}

async function doResearch(id: string): Promise<"wait" | "next"> {
  const keys = getKeys()
  const snapshot = await getRun(id)
  if (!snapshot) return "next"
  if (!keys.parallel) {
    await updateRun(id, (run) => {
      const context = stage(run, "context")
      context.status = "blocked"
      context.finishedAt = now()
      context.detail =
        "Parallel API key is missing. OpenAI’s score stays as the best fit."
      run.contextState = "skipped"
      finish(run)
      log(run, "context", context.detail)
    })
    return "next"
  }
  if (snapshot.brief.parallelMode === "decisions") {
    if (snapshot.parallelDecisionId || snapshot.contextState === "done") return "next"
    if (snapshot.contextState === "failed") {
      await updateRun(id, (run) => {
        finish(run)
      })
      return "next"
    }
    try {
      await updateRun(id, (run) => {
        run.contextState = "running"
        run.status = "researching"
        const context = stage(run, "context")
        context.status = "running"
        context.startedAt = context.startedAt ?? now()
        context.detail = "Parallel Decisions (fast) is answering this run. The default Task call is not used."
        log(run, "context", context.detail)
      })
      const decided = await decideResearch(
        snapshot.brief,
        snapshot.leads.filter(shouldClassifyLead),
        keys.parallel,
        snapshot.also
      )
      await updateRun(id, (run) => {
        run.parallelDecisionId = decided.decisionId
        applyResearch(run, decided.research)
        finish(run)
      })
    } catch (error) {
      const message = publicError(error, secrets())
      await updateRun(id, (run) => {
        run.contextState = "failed"
        const context = stage(run, "context")
        context.status = "failed"
        context.finishedAt = now()
        context.detail = message
        finish(run)
        log(run, "context", message)
      })
    }
    return "next"
  }
  if (snapshot.contextState === "failed" && !snapshot.parallelRunId) {
    await updateRun(id, (run) => {
      finish(run)
    })
    return "next"
  }
  if (!snapshot.parallelRunId) {
    const classifyLeads = snapshot.leads.filter(shouldClassifyLead)
    if (classifyLeads.length === 0) {
      await updateRun(id, (run) => {
        const context = stage(run, "context")
        context.status = "done"
        context.finishedAt = now()
        context.detail =
          run.brief.searchKind === "dump"
            ? "Parallel skipped: no dump lead confirmed by Exa and Firecrawl."
            : "Parallel skipped: no companies to classify."
        run.contextState = "skipped"
        finish(run)
        log(run, "context", context.detail)
      })
      return "next"
    }
    try {
      const created = await createResearch(
        snapshot.brief,
        classifyLeads,
        keys.parallel,
        snapshot.also
      )
      await updateRun(id, (run) => {
        run.parallelRunId = created.runId
        run.parallelInteractionId = created.interactionId
        run.contextState = "running"
        run.status = "researching"
        const context = stage(run, "context")
        context.status = "running"
        context.startedAt = now()
        context.detail = `Parallel ${created.processor} is researching the shortlist. Run ${created.runId}.`
        log(run, "context", context.detail)
      })
    } catch (error) {
      const message = publicError(error, secrets())
      await updateRun(id, (run) => {
        run.contextState = "failed"
        const context = stage(run, "context")
        context.status = "failed"
        context.finishedAt = now()
        context.detail = message
        finish(run)
        log(run, "context", message)
      })
    }
    return "next"
  }

  try {
    const status = await researchStatus(snapshot.parallelRunId, keys.parallel)
    const normalized = status.status.toLowerCase()
    if (normalized === "completed") {
      const parsed = await researchResult(snapshot.parallelRunId, keys.parallel)
      await updateRun(id, (run) => {
        if (!parsed) {
          run.contextState = "failed"
          const context = stage(run, "context")
          context.status = "failed"
          context.detail = "Parallel completed without a readable report."
          context.finishedAt = now()
          log(run, "context", context.detail)
        } else {
          applyResearch(run, parsed)
        }
        finish(run)
      })
      return "next"
    }
    if (normalized === "failed" || normalized === "cancelled" || normalized === "canceled") {
      await updateRun(id, (run) => {
        run.contextState = "failed"
        const context = stage(run, "context")
        context.status = "failed"
        context.finishedAt = now()
        context.detail = status.error || `Parallel status: ${status.status}.`
        finish(run)
        log(run, "context", context.detail)
      })
      return "next"
    }
    const started = snapshot.stages.find((item) => item.id === "context")?.startedAt
    const elapsed = started ? Date.now() - Date.parse(started) : 0
    if (elapsed > RESEARCH_BUDGET_MS) {
      await updateRun(id, (run) => {
        run.contextState = "deferred"
        const context = stage(run, "context")
        context.status = "blocked"
        context.detail = `Parallel is still running (${snapshot.parallelRunId}). OpenAI’s score stays until you reopen this run.`
        log(run, "context", context.detail)
        finish(run)
      })
      return "next"
    }
    await updateRun(id, (run) => {
      const context = stage(run, "context")
      context.status = "running"
      context.detail = `Parallel is ${status.status}. The market note is the long step.`
    })
    return "wait"
  } catch (error) {
    const message = publicError(error, secrets())
    const giveUp = await updateRun(id, (run) => {
      run.parallelErrors = (run.parallelErrors ?? 0) + 1
      log(run, "context", message)
      if ((run.parallelErrors ?? 0) >= 3) {
        run.contextState = "failed"
        const context = stage(run, "context")
        context.status = "failed"
        context.finishedAt = now()
        context.detail = message
        finish(run)
        return true
      }
      return false
    })
    return giveUp ? "next" : "wait"
  }
}

function applyOpenAI(run: Run, judgments: Awaited<ReturnType<typeof scoreLeads>>["leads"]) {
  for (const note of judgments) {
    const lead = run.leads.find(
      (item) => namesMatch(item.name, note.company) || namesMatch(item.domain, note.company)
    )
    if (!lead) continue
    lead.openai = {
      icp: note.icp,
      supplierFits: note.supplierFits,
      bestFit: note.bestFit,
      qualificationNeeded: note.qualificationNeeded,
      rationale: note.rationale,
    }
    // Signal uplift on OpenAI's ICP: never lowers it; best_fit is untouched.
    applyUplift(lead, "openai", { fresh: true })
  }
}

async function attachMissingActivity(id: string): Promise<"wait" | "ready"> {
  const keys = getKeys()
  const snapshot = await getRun(id)
  if (!snapshot) return "ready"
  if (!keys.exa) {
    await updateRun(id, (run) => {
      let filled = 0
      for (const lead of run.leads) {
        if (lead.activity) continue
        lead.activity = emptyActivity("Exa key missing. Activity was not searched.")
        filled += 1
      }
      if (filled) {
        const classify = stage(run, "classify")
        classify.status = "running"
        classify.startedAt = classify.startedAt ?? now()
        classify.detail = "Exa is not connected, so public activity was skipped."
        log(run, "classify", classify.detail)
      }
    })
    return "ready"
  }
  const pending = snapshot.leads.find((lead) => !lead.activity)
  if (!pending) return "ready"
  await updateRun(id, (run) => {
    const classify = stage(run, "classify")
    classify.status = "running"
    classify.startedAt = classify.startedAt ?? now()
    classify.detail = `Exa is looking for news, launches, new brands, and social activity. ${pending.name}.`
  })
  try {
    const snapshotActivity = await searchActivity(pending, snapshot.brief, keys.exa)
    await updateRun(id, (run) => {
      const lead = run.leads.find((item) => item.id === pending.id)
      if (!lead) return
      lead.activity = snapshotActivity
      stampIntelligence(run, lead)
      const recent = snapshotActivity.signals.length
      log(
        run,
        "classify",
        recent
          ? `Activity for ${lead.name}: ${recent} ${recent === 1 ? "signal" : "signals"}.`
          : `Activity for ${lead.name}: no news, launch, new brand, or social post in the last 24 months.`
      )
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (run) => {
      const lead = run.leads.find((item) => item.id === pending.id)
      if (!lead) return
      lead.activity = emptyActivity(message)
      log(run, "classify", `Activity search failed for ${lead.name}. ${message}`)
    })
  }
  return "wait"
}

async function attachMissingCommerce(id: string): Promise<"wait" | "ready"> {
  const keys = getKeys()
  const snapshot = await getRun(id)
  if (!snapshot) return "ready"
  if (!keys.exa) {
    await updateRun(id, (run) => {
      let filled = 0
      for (const lead of run.leads) {
        if (lead.commerce) continue
        lead.commerce = emptyCommerce("Exa key missing. Commercial signals were not searched.")
        filled += 1
      }
      if (filled) {
        const classify = stage(run, "classify")
        classify.status = "running"
        classify.startedAt = classify.startedAt ?? now()
        classify.detail = "Exa is not connected, so customs and restock signals were skipped."
        log(run, "classify", classify.detail)
      }
    })
    return "ready"
  }
  const pending = snapshot.leads.find((lead) => !lead.commerce)
  if (!pending) return "ready"
  await updateRun(id, (run) => {
    const classify = stage(run, "classify")
    classify.status = "running"
    classify.startedAt = classify.startedAt ?? now()
    classify.detail = `Exa is looking for customs, restock, trade-fair, and purchasing-hire signals. ${pending.name}.`
  })
  try {
    const snapshotCommerce = await searchCommerce(pending, snapshot.brief, keys.exa)
    await updateRun(id, (run) => {
      const lead = run.leads.find((item) => item.id === pending.id)
      if (!lead) return
      lead.commerce = snapshotCommerce
      stampIntelligence(run, lead)
      const recent = snapshotCommerce.signals.length
      log(
        run,
        "classify",
        recent
          ? `Commerce for ${lead.name}: ${recent} ${recent === 1 ? "signal" : "signals"}.`
          : `Commerce for ${lead.name}: no customs, restock, fair, or purchasing-hire signal in the last 24 months.`
      )
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (run) => {
      const lead = run.leads.find((item) => item.id === pending.id)
      if (!lead) return
      lead.commerce = emptyCommerce(message)
      log(run, "classify", `Commercial search failed for ${lead.name}. ${message}`)
    })
  }
  return "wait"
}

const ragRefreshAt = new Map<string, number>()
const RAG_REFRESH_MS = 15000

async function attachRag(id: string, refreshAll = false) {
  const snapshot = await getRun(id)
  if (!snapshot) return
  if (!ragConfigured()) {
    await updateRun(id, (run) => {
      let stamped = 0
      for (const lead of run.leads) {
        if (!lead.rag || ragNeedsRetry(lead)) {
          lead.rag = ragNotConfiguredMatch()
          stampIntelligence(run, lead)
          stamped += 1
        }
      }
      if (stamped > 0) {
        log(run, "classify", "RAG skipped: RAG_API_URL is not set. Cards will say unpublished — do not invent a match.")
      }
    })
    return
  }
  const pending = refreshAll
    ? snapshot.leads
    : snapshot.leads.filter((lead) => ragNeedsRetry(lead))
  if (pending.length === 0) return
  const classifyDone = stage(snapshot, "classify").status === "done"
  if (!classifyDone) {
    await updateRun(id, (run) => {
      const classify = stage(run, "classify")
      classify.status = "running"
      classify.startedAt = classify.startedAt ?? now()
      classify.detail = "RAG is comparing companies to the Chroma index."
    })
  }
  const matches = await matchLeads(pending)
  await updateRun(id, (run) => {
    let hits = 0
    for (const lead of run.leads) {
      const rag = matches.get(lead.id)
      if (!rag) continue
      lead.rag = rag
      stampIntelligence(run, lead)
      if (rag.match) hits += 1
    }
    log(
      run,
      "classify",
      `RAG matched ${hits} of ${matches.size} companies against Chroma.`
    )
  })
}

async function doScore(id: string) {
  const keys = getKeys()
  const snapshot = await getRun(id)
  if (!snapshot) return
  const activity = await attachMissingActivity(id)
  if (activity === "wait") return
  const commerce = await attachMissingCommerce(id)
  if (commerce === "wait") return
  // Versioned Autobound signals step. No-op without AUTOBOUND_API_KEY.
  const signals = await attachMissingSignals(id)
  if (signals === "wait") return
  await attachCustomsRecords(id)
  await attachRag(id)
  const current = (await getRun(id)) ?? snapshot
  if (!keys.openai) {
    await updateRun(id, (run) => {
      const classify = stage(run, "classify")
      classify.status = "blocked"
      classify.finishedAt = now()
      classify.detail = "OpenAI API key is missing. Parallel can still set the final best fit."
      log(run, "classify", classify.detail)
      run.status = "researching"
    })
    return
  }
  const classifyLeads = current.leads.filter(shouldClassifyLead)
  if (current.leads.length > 0 && classifyLeads.every((lead) => lead.openai) && classifyLeads.length > 0) {
    await updateRun(id, (run) => {
      run.status = "researching"
    })
    return
  }
  if (classifyLeads.length === 0) {
    await updateRun(id, (run) => {
      const classify = stage(run, "classify")
      classify.status = "done"
      classify.finishedAt = now()
      classify.detail =
        run.brief.searchKind === "dump"
          ? "Nenhuma lead do dump passou Exa + Firecrawl. OpenAI e Parallel não classificam nome só do arquivo."
          : "No companies were ready for OpenAI."
      log(run, "classify", classify.detail)
      run.status = "researching"
    })
    return
  }
  await updateRun(id, (run) => {
    const classify = stage(run, "classify")
    classify.status = "running"
    classify.startedAt = classify.startedAt ?? now()
    classify.detail =
      current.brief.searchKind === "dump"
        ? `OpenAI classifica ${classifyLeads.length} importadores confirmados por Exa e Firecrawl. Embarque é sinal forte, não pedido Kanechom/LQ.`
        : "OpenAI is scoring product fit against the activity evidence."
  })
  try {
    const scored = await scoreLeads(current.brief, classifyLeads, keys.openai, current.also)
    await updateRun(id, (run) => {
      applyOpenAI(run, scored.leads)
      if (scored.entry.purchaseProbability || scored.entry.strategy) run.entry = scored.entry
      const classify = stage(run, "classify")
      classify.status = scored.leads.length ? "done" : "failed"
      classify.finishedAt = now()
      classify.detail = scored.leads.length
        ? `OpenAI scored ${scored.leads.length} companies and set a purchase probability. Parallel still refines it.`
        : "OpenAI returned no scores. Parallel can still set best fit."
      log(run, "classify", classify.detail)
      run.status = "researching"
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (run) => {
      const classify = stage(run, "classify")
      classify.status = "failed"
      classify.finishedAt = now()
      classify.detail = message
      log(run, "classify", message)
      run.status = "researching"
    })
  }
}

async function maybeAttachDeferred(id: string) {
  const run = await getRun(id)
  const keys = getKeys()
  if (!run || run.contextState !== "deferred" || run.market || !run.parallelRunId || !keys.parallel) {
    return
  }
  const last = run.parallelCheckedAt ? Date.parse(run.parallelCheckedAt) : 0
  if (Date.now() - last < 20000) return
  await updateRun(id, (current) => {
    current.parallelCheckedAt = now()
  })
  try {
    const status = await researchStatus(run.parallelRunId, keys.parallel)
    if (status.status.toLowerCase() !== "completed") {
      await updateRun(id, (current) => {
        log(current, "context", `Parallel is still ${status.status}.`)
      })
      return
    }
    const parsed = await researchResult(run.parallelRunId, keys.parallel)
    if (!parsed) return
    await updateRun(id, (current) => {
      applyResearch(current, parsed)
      fileChecklist(current)
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (current) => {
      log(current, "context", message)
    })
  }
}

async function pump(id: string) {
  try {
    for (let guard = 0; guard < 1000; guard += 1) {
      const run = await getRun(id)
      if (!run || run.mode === "sample") return
      if (run.status === "failed") return
      if (run.status === "complete") {
        await attachTrade(id)
        await attachCustomsRecords(id)
        await maybeAttachDeferred(id)
        return
      }
      if (run.status === "queued" || run.status === "searching") {
        const pace = await doSearch(id)
        if (pace === "busy") return
        continue
      }
      if (run.status === "extracting") {
        void attachTrade(id)
        const pace = await doExtract(id)
        if (pace === "wait") await new Promise((resolve) => setTimeout(resolve, EXTRACT_POLL_MS))
        continue
      }
      if (run.status === "scoring") {
        await doScore(id)
        continue
      }
      if (run.status === "researching") {
        const action = await doResearch(id)
        if (action === "wait") await new Promise((resolve) => setTimeout(resolve, 12000))
        continue
      }
      return
    }
    await updateRun(id, (run) => {
      run.status = "failed"
      run.error = "The pipeline stopped after too many steps. Start a fresh qualification."
      log(run, "system", run.error)
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(id, (run) => {
      run.status = "failed"
      run.error = message
      log(run, "system", message)
    })
  }
}

async function doSearchTick(id: string) {
  const keys = getKeys()
  const current = await getRun(id)
  if (!current) return
  if (!keys.exa) {
    await updateRun(id, (run) => {
      run.status = "failed"
      run.error = "Add an Exa API key under Sources, then start a new qualification."
      const search = stage(run, "search")
      search.status = "failed"
      search.detail = run.error
      search.finishedAt = now()
      log(run, "search", run.error ?? "Exa key missing.")
    })
    return
  }
  if (current.leads.length > 0 && !current.searchTasks && !current.searchJobId) {
    await updateRun(id, (run) => {
      if (run.status === "searching" || run.status === "queued") run.status = "extracting"
      const search = stage(run, "search")
      if (search.status === "running" || search.status === "pending") {
        search.status = "done"
        search.finishedAt = now()
      }
    })
    return
  }
  if (current.brief.searchKind === "dump") {
    try {
      await runDumpSearch(id, keys.exa)
      void attachTrade(id)
    } catch (error) {
      const message = publicError(error, secrets())
      await updateRun(id, (run) => {
        run.status = "failed"
        run.error = message
        const search = stage(run, "search")
        search.status = "failed"
        search.detail = message
        search.finishedAt = now()
        log(run, "search", message)
      })
    }
    return
  }
  const result = await advanceExa(
    current.brief,
    keys.exa,
    current.searchTasks
      ? {
          tasks: current.searchTasks,
          index: current.searchTaskIndex ?? 0,
          jobId: current.searchJobId,
          outside: current.searchOutside ?? 0,
        }
      : undefined,
    current.leads,
    current.also
  )
  await updateRun(id, (run) => {
    run.searchTasks = result.progress.tasks
    run.searchTaskIndex = result.progress.index
    run.searchJobId = result.progress.jobId
    run.searchOutside = result.outside
    run.leads = result.leads
    run.status = "searching"
    const search = stage(run, "search")
    search.status = "running"
    search.startedAt = search.startedAt ?? now()
    if (result.error) {
      run.status = "failed"
      run.error = result.error
      search.status = "failed"
      search.detail = result.error
      search.finishedAt = now()
      log(run, "search", result.error)
      return
    }
    if (!result.done) {
      search.detail = result.pending ? "Exa Agent is searching." : "Starting the next Exa search."
      return
    }
    if (result.leads.length === 0) {
      run.status = "failed"
      run.error =
        result.outside > 0
          ? `Exa suggested ${result.outside} ${result.outside === 1 ? "company" : "companies"} from another country or another supplier. None were in ${run.brief.markets}.`
          : "Exa returned no company pages after the supplier’s own domain was removed. Broaden the products or the markets and run again."
      search.status = "failed"
      search.detail = run.error
      search.finishedAt = now()
      log(run, "search", run.error)
      return
    }
    run.status = "extracting"
    search.status = "done"
    search.finishedAt = now()
    search.detail = `Exa Agent search returned ${result.leads.length} companies.`
    log(run, "search", search.detail)
    const extract = stage(run, "extract")
    extract.status = "running"
    extract.startedAt = now()
    extract.detail = "Reading the first company page."
  })
  if (result.done && result.leads.length > 0 && !result.error) void attachTrade(id)
}

async function doExtractTick(id: string) {
  await doExtract(id)
}

async function stepOnce(id: string) {
  const run = await getRun(id)
  if (!run || run.mode === "sample" || run.status === "failed") return
  if (run.status === "complete") {
    await attachTrade(id)
    await attachCustomsRecords(id)
    await maybeAttachDeferred(id)
    return
  }
  if (run.status === "queued" || run.status === "searching") {
    await doSearchTick(id)
    return
  }
  if (run.status === "extracting") {
    await doExtractTick(id)
    return
  }
  if (run.status === "scoring") {
    await doScore(id)
    return
  }
  if (run.status === "researching") await doResearch(id)
}

export async function ensurePump(id: string) {
  if (process.env.NETLIFY === "true") {
    await stepOnce(id)
    return
  }
  if (id === SAMPLE_RUN_ID || running.has(id)) return
  const run = await getRun(id)
  if (!run || run.mode === "sample") return
  const active = run.status !== "complete" && run.status !== "failed"
  const deferred =
    run.status === "complete" && run.contextState === "deferred" && !run.market
  const tradePending = tradeRetryDue(run)
  const ragStale =
    run.status === "complete" && Date.now() - (ragRefreshAt.get(id) ?? 0) > RAG_REFRESH_MS
  const ragPending =
    ragConfigured() &&
    run.leads.length > 0 &&
    (run.leads.some((lead) => ragNeedsRetry(lead)) || ragStale)
  const filingPending = run.status === "complete" && run.leads.some((lead) => !lead.filingChecked)
  if (!active && !deferred && !tradePending && !ragPending && !filingPending) return
  if (!active && ragPending && !deferred && !tradePending && !filingPending) {
    running.add(id)
    void attachRag(id, ragStale)
      .finally(() => {
        ragRefreshAt.set(id, Date.now())
        running.delete(id)
      })
    return
  }
  if (deferred) {
    const last = run.parallelCheckedAt ? Date.parse(run.parallelCheckedAt) : 0
    if (Date.now() - last < 20000) return
  }
  running.add(id)
  void pump(id).finally(() => running.delete(id))
}

export async function startRun(brief: Brief, also?: Brief): Promise<Run> {
  const run = createRun(brief, also)
  await insertRun(run)
  await ensurePump(run.id)
  return run
}

export function leadById(run: Run, leadId: string): Lead | undefined {
  return run.leads.find((lead) => lead.id === leadId)
}

const diligenceBusy = new Set<string>()

function ensureDiligenceStage(run: Run) {
  if (run.stages.some((item) => item.id === "diligence")) return
  run.stages.push({
    id: "diligence",
    status: "pending",
    detail: "Commercial due diligence waits until you select companies and a brand.",
  })
}

function markDiligenceStage(run: Run, detail: string, status: StageState["status"] = "running") {
  ensureDiligenceStage(run)
  const item = stage(run, "diligence")
  item.status = status
  item.detail = detail
  item.startedAt = item.startedAt ?? now()
  if (status === "done" || status === "failed") item.finishedAt = now()
}

async function searchProbeHits(query: string, key: string) {
  const data = await requestJson("https://api.exa.ai/search", {
    method: "POST",
    timeoutMs: 25000,
    headers: { Authorization: `Bearer ${key}`, "x-api-key": key },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults: 5,
      contents: {
        text: { maxCharacters: 280 },
        highlights: { maxHighlights: 1, maxCharacters: 160 },
      },
    }),
  })
  const results = (data as { results?: unknown } | null)?.results
  return hitsFromSearch(Array.isArray(results) ? results : [])
}

async function collectProbes(
  lead: Lead,
  brief: Brief,
  brand: string,
  key: string | undefined
): Promise<{ probes: DiligenceProbe[]; reason: string; ran: boolean }> {
  const kind = brandKindOf(brand)
  const states = classifyBlocks(kind, lead)
  const gaps = coverageGaps(kind, lead, brief, states)
  if (gaps.length === 0) {
    return { probes: [], ran: false, reason: "O dossiê já responde às perguntas da due diligence." }
  }
  if (!key) {
    return {
      probes: gaps.map((gap) => failedProbe(gap, "Exa key missing. Complementary search was skipped.")),
      ran: false,
      reason: "Há lacunas, mas a busca complementar ficou sem chave Exa.",
    }
  }
  const probes: DiligenceProbe[] = []
  for (const gap of gaps) {
    try {
      const hits = await searchProbeHits(gap.query, key)
      probes.push(probeFromSearch(gap, hits))
    } catch (error) {
      probes.push(failedProbe(gap, error instanceof Error ? error.message : "Complementary search failed."))
    }
  }
  return {
    probes,
    ran: true,
    reason: `Busca complementar em ${gaps.length} ${gaps.length === 1 ? "lacuna" : "lacunas"}.`,
  }
}

async function fileDiligence(runId: string, leadId: string, brand: string) {
  const job = `${runId}:${leadId}:${brand.toLowerCase()}`
  if (diligenceBusy.has(job)) return
  diligenceBusy.add(job)
  try {
    const snapshot = await getRun(runId)
    if (!snapshot) return
    const lead = snapshot.leads.find((item) => item.id === leadId)
    if (!lead) return
    const keys = getKeys()
    const collected = await collectProbes(lead, snapshot.brief, brand, keys.exa)
    let draft = {
      findings: [] as Awaited<ReturnType<typeof draftDiligence>>["findings"],
      narratives: {} as Awaited<ReturnType<typeof draftDiligence>>["narratives"],
      citations: [] as Awaited<ReturnType<typeof draftDiligence>>["citations"],
    }
    if (keys.openai) {
      try {
        draft = await draftDiligence(snapshot.brief, brand, lead, collected.probes, keys.openai)
      } catch {
        draft = { findings: [], narratives: {}, citations: [] }
      }
    }
    await updateRun(runId, (run) => {
      const current = run.leads.find((item) => item.id === leadId)
      if (!current) return
      const previous = latestReport(current.diligence, brand)
      const report = buildReport({
        brand,
        lead: current,
        brief: run.brief,
        findings: draft.findings,
        probes: collected.probes,
        narratives: draft.narratives,
        citations: draft.citations,
        complementary: { ran: collected.ran, reason: collected.reason },
        previous,
      })
      current.diligence = [...(current.diligence ?? []).filter((item) => item.status !== "running" || item.brand !== brand), report]
      const done = run.leads.flatMap((item) => item.diligence ?? []).filter((item) => item.status === "done").length
      markDiligenceStage(run, `Due diligence gravada para ${current.name} · ${brand}. ${done} relatórios no total.`, "done")
      log(run, "diligence", `Due diligence ${brand} · ${current.name} · opportunity ${report.opportunityScore} · confidence ${report.confidence}.`)
    })
  } catch (error) {
    const message = publicError(error, secrets())
    await updateRun(runId, (run) => {
      const current = run.leads.find((item) => item.id === leadId)
      if (current) {
        current.diligence = (current.diligence ?? []).map((item) =>
          item.status === "running" && item.brand === brand ? { ...item, status: "failed", error: message } : item
        )
      }
      markDiligenceStage(run, message, "failed")
      log(run, "diligence", message)
    })
  } finally {
    diligenceBusy.delete(job)
  }
}

export async function startDiligence(
  runId: string,
  leadIds: string[],
  brands: string[],
  _options: { deepen?: boolean } = {}
): Promise<{ queued: number; error?: string }> {
  const run = await getRun(runId)
  if (!run || run.mode === "sample") {
    return { queued: 0, error: "This qualification is not available for due diligence." }
  }
  const wanted = brands.map((item) => item.trim()).filter(Boolean)
  if (wanted.length === 0) return { queued: 0, error: "Choose Kanechom, LQ Professional, or both." }
  const targets = run.leads.filter((lead) => leadIds.includes(lead.id))
  if (targets.length === 0) return { queued: 0, error: "Select at least one company." }
  let queued = 0
  await updateRun(runId, (current) => {
    ensureDiligenceStage(current)
    for (const lead of current.leads) {
      if (!leadIds.includes(lead.id)) continue
      for (const brand of wanted) {
        const running = (lead.diligence ?? []).some(
          (item) => item.brand === brand && item.status === "running"
        )
        if (running) continue
        lead.diligence = [
          ...(lead.diligence ?? []),
          buildReport({
            brand,
            lead,
            brief: current.brief,
            status: "running",
            complementary: { ran: false, reason: "Investigation started." },
          }),
        ]
        queued += 1
      }
    }
    markDiligenceStage(
      current,
      queued ? `Due diligence running for ${queued} ${queued === 1 ? "report" : "reports"}.` : "Nothing new to queue."
    )
    if (queued) log(current, "diligence", `Queued ${queued} commercial due diligence ${queued === 1 ? "report" : "reports"}.`)
  })
  for (const lead of targets) {
    for (const brand of wanted) {
      void fileDiligence(runId, lead.id, brand)
    }
  }
  return { queued }
}
