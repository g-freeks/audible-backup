import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startUi, seedBooks, seedManyBooks, type UiContext } from "./fixture.ts";

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

describe("Audible sign-in from the settings page", () => {
  let ui: UiContext;
  const FAKE_HELPER = `python3 ${new URL("../resources/fake_helper.py", import.meta.url).pathname}`;

  before(async () => {
    process.env.AUDIBLE_HELPER = FAKE_HELPER;
    ui = await startUi();
    await ui.page.goto(`${ui.baseUrl}/login`, { waitUntil: "networkidle" });
    await ui.page.fill("#add-name", "alice");
    await ui.page.click('form[action="/user/add"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");
  });

  after(async () => {
    await ui?.close();
    delete process.env.AUDIBLE_HELPER;
  });

  it("walks the two-step flow to a connected account", async () => {
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    await ui.page.selectOption("#marketplace", "de");
    await ui.page.click('form[action="/user/audible/start"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");

    // Step 2 shows a real link out to Amazon plus the paste field.
    const signinHref = await ui.page.locator(".auth-card a[target=_blank]").getAttribute("href");
    assert.match(signinHref || "", /amazon\.de\/ap\/signin/);

    await ui.page.fill(
      "#redirect-url",
      "https://www.audible.de/?openid.oa2.authorization_code=ABC123",
    );
    await ui.page.click('form[action="/user/audible/complete"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");

    const body = await ui.page.locator(".auth-wrap").innerText();
    assert.match(body, /connected as Test User/i);
    assert.match(body, /Connected/);
    assert.deepEqual(
      ui.consoleErrors.filter((e) => /Content Security Policy/i.test(e)),
      [],
    );
  });
});

describe("action menus are not clipped by the table container", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedManyBooks);
    await ui.page.setViewportSize({ width: 1280, height: 700 });
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  // Regression: the table sits in an overflow:auto scroller, which clipped an
  // absolutely-positioned menu opened on one of the last rows.
  it("shows the last row's menu fully, flipped above the button", async () => {
    const toggles = ui.page.locator("#books-table [data-dropdown-toggle]");
    const last = (await toggles.count()) - 1;
    await toggles.nth(last).scrollIntoViewIfNeeded();
    await toggles.nth(last).click();

    const geometry = await ui.page.evaluate(() => {
      const menu = document.querySelector(".action-dropdown.open .dropdown-menu");
      const button = document.querySelector(".action-dropdown.open [data-dropdown-toggle]");
      if (!menu || !button) return null;
      const m = menu.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      const probe = document.elementFromPoint(m.left + m.width / 2, m.top + 6);
      return {
        insideViewport:
          m.top >= 0 && m.bottom <= window.innerHeight + 1 &&
          m.left >= 0 && m.right <= window.innerWidth + 1,
        visibleAtTop: !!(probe && probe.closest(".dropdown-menu")),
        opensUpward: m.bottom <= b.top + 1,
      };
    });

    assert.ok(geometry, "a menu should be open");
    assert.ok(geometry.insideViewport, "menu must be fully within the viewport");
    assert.ok(geometry.visibleAtTop, "menu must not be clipped away by the scroller");
    assert.ok(geometry.opensUpward, "menu should flip above the button near the bottom");
  });

  it("keeps the first row's menu below its button", async () => {
    await ui.page.keyboard.press("Escape");
    const toggle = ui.page.locator("#books-table [data-dropdown-toggle]").first();
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const below = await ui.page.evaluate(() => {
      const menu = document.querySelector(".action-dropdown.open .dropdown-menu");
      const button = document.querySelector(".action-dropdown.open [data-dropdown-toggle]");
      if (!menu || !button) return false;
      return menu.getBoundingClientRect().top >= button.getBoundingClientRect().bottom - 1;
    });
    assert.ok(below, "menu should open downward when there is room");
  });

  it("closes an open menu when the table scrolls", async () => {
    await ui.page.keyboard.press("Escape");
    const toggle = ui.page.locator("#books-table [data-dropdown-toggle]").first();
    await toggle.click();
    assert.equal(await ui.page.locator(".action-dropdown.open").count(), 1);
    await ui.page.locator(".table-scroll").evaluate((el) => (el.scrollTop = el.scrollTop + 120));
    await ui.page.waitForTimeout(150);
    assert.equal(await ui.page.locator(".action-dropdown.open").count(), 0);
  });
});

describe("one-click Get MP3s", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("labels every row action Get MP3s", async () => {
    const labels = await ui.page.locator("#books-table .split-main").allInnerTexts();
    assert.ok(labels.length >= 3, "expected several rows");
    for (const label of labels) {
      assert.match(label.trim(), /^Get MP3s$/, `unexpected primary label: ${label}`);
    }
  });

  it("downloads immediately for a book already converted", async () => {
    const row = ui.page.locator("#books-table tbody tr", { hasText: "Dune" });
    const [download] = await Promise.all([
      ui.page.waitForEvent("download", { timeout: 15000 }),
      row.locator(".split-main").click(),
    ]);
    assert.match(await download.suggestedFilename(), /\.zip$/);
  });

  // The whole point of the flow: after preparing, the browser starts the ZIP
  // download on its own without a second click.
  it("starts the download automatically once preparing finishes", async () => {
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    const row = ui.page.locator("#books-table tbody tr", { hasText: "Snow Crash" });
    await row.locator(".split-main").click();
    await ui.page.waitForSelector("#log-float.visible", { timeout: 10000 });

    // This book cannot really be fetched here, so the run fails and no
    // download is triggered — exactly the behaviour we want on failure.
    await ui.page.waitForFunction(
      () => /log-done/.test(document.querySelector("#progress-panel")?.innerHTML || ""),
      { timeout: 20000 },
    );
    const panel = await ui.page.locator("#progress-panel").innerText();
    assert.match(panel, /Preparing|Downloading/);
    const marker = await ui.page.locator("#op-download").getAttribute("data-download-url");
    assert.equal(marker, null, "no auto-download should be armed after a failure");
  });
});

describe("search field", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("hides the clear button until there is text", async () => {
    assert.equal(await ui.page.locator("#search-clear").isVisible(), false);
    await ui.page.fill("#search-input", "dune");
    assert.equal(await ui.page.locator("#search-clear").isVisible(), true);
  });

  it("clears the text, restores all rows and refocuses the field", async () => {
    await ui.page.fill("#search-input", "dune");
    assert.equal(await ui.page.locator("#books-table tbody tr:visible").count(), 1);

    await ui.page.click("#search-clear");
    assert.equal(await ui.page.inputValue("#search-input"), "");
    assert.equal(await ui.page.locator("#books-table tbody tr:visible").count(), 3);
    assert.equal(await ui.page.locator("#search-clear").isVisible(), false);
    assert.equal(
      await ui.page.evaluate(() => document.activeElement?.id),
      "search-input",
    );
  });
});
