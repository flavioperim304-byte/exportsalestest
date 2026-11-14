import assert from "node:assert/strict"
import test from "node:test"
import { findContactPage, mergePages, readCompanyPages } from "../lib/firecrawl"
import type { Brief } from "../lib/types"

// REAL DATA: values and URLs published by the companies, found by the Firecrawl measurement of 14/11/2026.

test("the contact page is found among the mapped links and the home page is skipped", () => {
  assert.equal(
    findContactPage({ links: [{ url: "https://www.agenciaymercadeo.com/" }, { url: "https://www.agenciaymercadeo.com/contacto" }] }, "https://www.agenciaymercadeo.com/"),
    "https://www.agenciaymercadeo.com/contacto"
  )
  assert.equal(
    findContactPage({ links: ["https://eurostylesas.com/index.php/contactanos"] }, "https://eurostylesas.com/"),
    "https://eurostylesas.com/index.php/contactanos"
  )
  assert.equal(findContactPage({ links: [{ url: "https://glowy.pe/" }] }, "https://glowy.pe/"), undefined)
  assert.equal(findContactPage({}, "https://glowy.pe/"), undefined)
})

test("contacts published only on the contact page keep that page as their source (Euro Style)", () => {
  const contact = "https://eurostylesas.com/index.php/contactanos"
  const merged = mergePages([
    { url: "https://eurostylesas.com/", json: null },
    {
      url: contact,
      json: { email: "contacto@eurostylesas.com", phone: "3102696836", whatsapp: "3102696836", website: "https://eurostylesas.com" },
    },
  ])!
  assert.equal(merged.ok, true)
  assert.equal(merged.email, "contacto@eurostylesas.com")
  assert.equal(merged.whatsapp, "3102696836")
  assert.deepEqual(merged.contactSources, { email: contact, phone: contact, whatsapp: contact, website: contact })
  assert.deepEqual(merged.pagesRead, [contact])
  assert.equal(merged.keyPerson, "", "an unpublished person stays empty")
})

test("contacts from the home page keep the home page as their source (Productos WOW)", () => {
  const home = "https://www.productoswow.com/"
  const merged = mergePages([
    { url: home, json: { email: "info@productoswow.com", phone: "(601) 616-3475", whatsapp: "(316) 7424319", website: "www.productoswow.com" } },
  ])!
  assert.deepEqual(merged.contactSources, { email: home, phone: home, whatsapp: home, website: home })
})

test("pages without a profile or contacts give no extraction", () => {
  assert.equal(mergePages([{ url: "https://www.dipaso.com.ec/", json: null }]), null)
  assert.equal(mergePages([]), null)
})

test("a lead without an http page is not sent to Firecrawl", async () => {
  const result = await readCompanyPages("dipaso.com.ec", {} as Brief, "unused")
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /no http/)
})
