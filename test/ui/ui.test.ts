import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startUi, seedBooks, type UiContext } from "./fixture.ts";

/**
 * Browser tests. Every case here covers a failure mode that HTML-level tests
 * structurally cannot catch: htmx attribute inheritance, CSP enforcement,
 * and delegated event handlers.
 */

describe("library page in a browser", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("loads with no console errors and no CSP violations", () => {
    const csp = ui.consoleErrors.filter((e) => /Content Security Policy/i.test(e));
    assert.deepEqual(csp, [], "CSP must not block our own scripts");
    assert.deepEqual(ui.consoleErrors, [], "no console errors on load");
  });

  it("runs the external app.js under the strict CSP", async () => {
    // If app.js were blocked, no delegated handler would be registered and
    // this class toggle would never happen.
    await ui.page.locator("[data-dropdown-toggle]").first().click();
    assert.equal(await ui.page.locator(".action-dropdown.open").count(), 1);
  });

  it("closes dropdowns with Escape", async () => {
    await ui.page.locator("[data-dropdown-toggle]").first().click();
    await ui.page.keyboard.press("Escape");
    assert.equal(await ui.page.locator(".action-dropdown.open").count(), 0);
  });

  it("filters rows via the search box", async () => {
    await ui.page.fill("#search-input", "dune");
    await ui.page.waitForTimeout(150);
    assert.equal(await ui.page.locator("#books-table tbody tr:visible").count(), 1);
    await ui.page.fill("#search-input", "");
    await ui.page.waitForTimeout(150);
    assert.equal(await ui.page.locator("#books-table tbody tr:visible").count(), 3);
  });

  it("sorts columns and exposes aria-sort", async () => {
    const header = ui.page.locator("th.sortable").first();
    await header.click();
    assert.equal(await header.getAttribute("aria-sort"), "ascending");
    await header.click();
    assert.equal(await header.getAttribute("aria-sort"), "descending");
  });

  it("toggles status filter pills", async () => {
    const pill = ui.page.locator('.filter-btn[data-status="converted"]');
    await pill.click();
    assert.equal(await pill.getAttribute("aria-pressed"), "false");
    assert.equal(await ui.page.locator("#books-table tbody tr:visible").count(), 2);
    await pill.click();
    assert.equal(await pill.getAttribute("aria-pressed"), "true");
  });
});

describe("operations give visible feedback", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  // Regression: hx-select on the container was inherited by these buttons,
  // so their responses were filtered to nothing and swapped in empty.
  it("shows the log panel when Sync Library is clicked", async () => {
    await ui.page.click('button:has-text("Sync Library")');
    await ui.page.waitForSelector("#log-float.visible", { timeout: 10000 });
    const text = await ui.page.locator("#progress-panel").innerText();
    assert.match(text, /Sync started/, "log panel must render the response");
    assert.ok(text.trim().length > 0, "panel must not be empty");
  });

  it("streams progress log lines over SSE", async () => {
    await ui.page.waitForFunction(
      () => {
        const el = document.querySelector("#progress-panel");
        return !!el && el.querySelectorAll(".log-line").length > 1;
      },
      { timeout: 15000 },
    );
    const lines = await ui.page.locator("#progress-panel .log-line").count();
    assert.ok(lines > 1, `expected streamed log lines, got ${lines}`);
  });

  it("shows the log panel when Convert All is clicked", async () => {
    await ui.page.reload({ waitUntil: "networkidle" });
    await ui.page.click('button:has-text("Convert All")');
    await ui.page.waitForSelector("#log-float.visible", { timeout: 10000 });
    const text = await ui.page.locator("#progress-panel").innerText();
    assert.match(text, /Conversion started/);
  });
});

describe("user navigation", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi();
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("offers sign-in / add-user before any user exists", async () => {
    assert.equal(await ui.page.locator('.topbar a[href="/login"]').count(), 1);
  });

  it("creates the first user through the UI and shows the switcher", async () => {
    await ui.page.click('.topbar a[href="/login"]');
    await ui.page.fill("#add-name", "alice");
    await ui.page.click('form[action="/user/add"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");

    const toggle = ui.page.locator(".topbar [data-dropdown-toggle]");
    assert.match((await toggle.innerText()).trim(), /^alice/);
    await toggle.click();
    const menu = await ui.page.locator(".topbar .dropdown-menu").innerText();
    for (const entry of ["Settings", "Add user", "Sign out"]) {
      assert.match(menu, new RegExp(entry));
    }
  });

  it("keeps the topbar on the settings page", async () => {
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    assert.equal(await ui.page.locator(".topbar").count(), 1);
  });
});
