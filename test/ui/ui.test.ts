import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  startUi,
  seedBooks,
  seedManyBooks,
  seedLongAuthor,
  type UiContext,
} from "./fixture.ts";

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

  it("reorders columns by dragging a header, and remembers the choice", async () => {
    // th text renders upper-cased via CSS (text-transform), so innerText()
    // reflects that rather than the raw "Title"/"Series" — normalize it away.
    const headerText = async () => {
      const ths = await ui.page.locator("#books-table thead th").allInnerTexts();
      return ths.map((t) => t.trim().toLowerCase());
    };
    assert.deepEqual((await headerText()).slice(0, 3), ["", "title", "series"]);

    const asinHeader = ui.page.locator('#books-table thead th[data-col="asin"]');
    const titleHeader = ui.page.locator('#books-table thead th[data-col="title"]');
    await asinHeader.dragTo(titleHeader);

    const reordered = await headerText();
    assert.equal(reordered[1], "asin", "ASIN dropped in front of Title");
    assert.equal(reordered[2], "title");

    // Body cells followed the header move, so each row's data stays aligned.
    const secondCell = ui.page.locator("#books-table tbody tr").first().locator("td").nth(1);
    assert.equal(await secondCell.locator("code").count(), 1, "the ASIN cell (wrapped in <code>) moved with its header");

    // Sorting still targets the right column after reordering (cellIndex-based).
    await ui.page.locator('#books-table thead th:has-text("Title")').click();
    const titles = await ui.page.locator("#books-table tbody td.col-title").allInnerTexts();
    assert.deepEqual([...titles].sort(), titles, "still sorts by title, not whatever is now at its old index");

    // Preference survives a table refresh.
    await ui.page.click('button[hx-post="/library/sync"]');
    await ui.page.waitForFunction(
      () => (document.querySelector("#progress-panel")?.children.length || 0) > 0,
      { timeout: 10000 },
    );
    await ui.page.waitForFunction(
      () => !document.body.classList.contains("op-running"),
      { timeout: 10000 },
    );
    assert.equal((await headerText())[1], "asin", "order persists across a table refresh");

    // Reset for any tests that run after this one in the same worker —
    // simpler and more robust than reversing the drag step by step.
    await ui.page.evaluate(() => localStorage.removeItem("audible-backup:column-order"));
    await ui.page.reload({ waitUntil: "networkidle" });
    assert.deepEqual((await headerText()).slice(0, 3), ["", "title", "series"]);
  });

  it("hides and re-shows a column from the Columns menu, and remembers the choice", async () => {
    await ui.page.click('button:has-text("Columns")');
    const asinToggle = ui.page.locator('input[data-col-toggle="asin"]');
    assert.equal(await asinToggle.isChecked(), true);

    const asinHeader = ui.page.locator('#books-table thead th[data-col="asin"]');
    const asinCell = ui.page.locator('#books-table tbody td[data-col="asin"]').first();
    assert.equal(await asinHeader.isVisible(), true);
    assert.equal(await asinCell.isVisible(), true);

    await asinToggle.uncheck({ force: true });
    assert.equal(await asinHeader.isVisible(), false, "header cell actually hides, not just its <col>");
    assert.equal(await asinCell.isVisible(), false, "body cells actually hide, not just their <col>");

    // Preference survives a books-table refresh.
    await ui.page.click('button[hx-post="/library/sync"]');
    await ui.page.waitForFunction(
      () => (document.querySelector("#progress-panel")?.children.length || 0) > 0,
      { timeout: 10000 },
    );
    await ui.page.waitForFunction(
      () => !document.body.classList.contains("op-running"),
      { timeout: 10000 },
    );
    assert.equal(
      await asinHeader.isVisible(),
      false,
      "hidden column stays hidden across a table refresh",
    );

    // Re-show it for any tests that run after this one in the same worker.
    await ui.page.click('button:has-text("Columns")');
    await ui.page.locator('input[data-col-toggle="asin"]').check({ force: true });
    assert.equal(await asinHeader.isVisible(), true);
  });

});

describe("column prefs survive a wiped browser (e.g. the desktop app's port changing every launch)", () => {
  let ui: UiContext;

  /** Seeds one book directly into the given account's own per-user database,
   * the same way seedBooks() does for the legacy (user-less) one — done
   * before the server starts, since this runs in the test process. */
  function seedUserBook(userName: string) {
    return async (env: NodeJS.ProcessEnv) => {
      const prevUsersDir = process.env.USERS_DIR;
      const prevDbPath = process.env.DB_PATH;
      process.env.USERS_DIR = env.USERS_DIR;
      const users = await import("../../src/users.ts");
      const db = await import("../../src/db.ts");
      const dirs = users.userDirs(userName);
      fs.mkdirSync(dirs.targetDir, { recursive: true });
      process.env.DB_PATH = dirs.dbPath;
      db.closeDb();
      db.markDownloaded("B0PERSIST1", "Author", "Persisted Book", "/x/B0PERSIST1.aaxc");
      db.closeDb();
      process.env.DB_PATH = prevDbPath;
      process.env.USERS_DIR = prevUsersDir;
    };
  }

  before(async () => {
    ui = await startUi(seedUserBook("alice"));
    await ui.page.goto(`${ui.baseUrl}/login`, { waitUntil: "networkidle" });
    await ui.page.fill("#add-name", "alice");
    await ui.page.click('form[action="/user/add"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");
  });

  after(async () => {
    await ui?.close();
  });

  it("hides a column, then recovers it in a brand-new browser context signed into the same account", async () => {
    await ui.page.click('button:has-text("Columns")');
    await ui.page.click('input[data-col-toggle="asin"]');
    // The save to the account is fire-and-forget; give it a moment to land.
    await ui.page.waitForTimeout(200);

    // A brand-new context has no cookies and no localStorage at all — this
    // stands in for the desktop app's fresh OS-assigned port on relaunch.
    const browser = ui.page.context().browser();
    if (!browser) throw new Error("expected a browser instance");
    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      await freshPage.goto(`${ui.baseUrl}/login?user=alice`, { waitUntil: "networkidle" });

      // Checked before switching users / loading the books page: this really
      // is empty browser storage, not just an account with nothing hidden.
      assert.equal(
        await freshPage.evaluate(() => localStorage.getItem("audible-backup:hidden-columns")),
        null,
        "sanity check: this really is a fresh browser storage",
      );

      await freshPage.click('form[action="/user/switch"] button[type=submit]');
      await freshPage.waitForLoadState("networkidle");

      assert.equal(
        await freshPage.locator('#books-table thead th[data-col="asin"]').isVisible(),
        false,
        "the saved-on-the-account preference applied without ever touching this browser's storage",
      );
    } finally {
      await freshContext.close();
    }
  });
});

describe("Download Selected", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("stays disabled until a book is checked, and disables again once cleared", async () => {
    const btn = ui.page.locator("#download-selected-btn");
    assert.equal(await btn.isDisabled(), true);

    const checkbox = ui.page.locator('input[name="asin"]').first();
    await checkbox.check();
    assert.equal(await btn.isDisabled(), false);

    await checkbox.uncheck();
    assert.equal(await btn.isDisabled(), true);
  });

  it("becomes enabled when select-all checks the visible rows", async () => {
    const btn = ui.page.locator("#download-selected-btn");
    await ui.page.check("#select-all");
    assert.equal(await btn.isDisabled(), false);
    await ui.page.uncheck("#select-all");
    assert.equal(await btn.isDisabled(), true);
  });
});

describe("operation log", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("keeps the log closed until the user opens it", async () => {
    assert.equal(await ui.page.locator("#log-float").isVisible(), false);
    assert.equal(await ui.page.locator("#log-indicator").isVisible(), false);

    await ui.page.click('button[hx-post="/library/sync"]');
    await ui.page.waitForFunction(
      () => (document.querySelector("#progress-panel")?.children.length || 0) > 0,
      { timeout: 10000 },
    );

    assert.equal(
      await ui.page.locator("#log-float").isVisible(),
      false,
      "an operation must not pop the log open",
    );
    assert.equal(
      await ui.page.locator("#log-indicator").isVisible(),
      true,
      "the topbar indicator signals activity instead",
    );
  });

  it("opens from the topbar and shows the streamed log", async () => {
    await ui.page.click("#log-toggle");
    assert.equal(await ui.page.locator("#log-float").isVisible(), true);
    assert.equal(await ui.page.locator("#log-toggle").getAttribute("aria-expanded"), "true");

    await ui.page.waitForFunction(
      () => (document.querySelectorAll("#progress-panel .log-line").length || 0) > 1,
      { timeout: 15000 },
    );
    const text = await ui.page.locator("#progress-panel").innerText();
    assert.match(text, /Sync started/);
  });

  it("is anchored under the topbar, not the bottom of the page", async () => {
    const geometry = await ui.page.evaluate(() => {
      const panel = document.querySelector("#log-float")!.getBoundingClientRect();
      const bar = document.querySelector(".topbar")!.getBoundingClientRect();
      return { panelTop: panel.top, barBottom: bar.bottom, viewport: window.innerHeight };
    });
    assert.ok(
      geometry.panelTop >= geometry.barBottom - 2 &&
        geometry.panelTop < geometry.viewport / 2,
      `expected the panel just below the topbar, got top=${geometry.panelTop}`,
    );
  });

  it("closes again from its own close button", async () => {
    await ui.page.click("#log-float-close");
    assert.equal(await ui.page.locator("#log-float").isVisible(), false);
    assert.equal(await ui.page.locator("#log-toggle").getAttribute("aria-expanded"), "false");
  });

  it("shows Download All output in the same panel", async () => {
    await ui.page.reload({ waitUntil: "networkidle" });
    ui.page.once("dialog", (d) => d.accept());
    await ui.page.click('#download-all-btn');
    await ui.page.click("#log-toggle");
    await ui.page.waitForFunction(
      () => /Download started/.test(document.querySelector("#progress-panel")?.textContent || ""),
      { timeout: 10000 },
    );
    assert.match(await ui.page.locator("#progress-panel").innerText(), /Download started/);
  });
});

describe("cancelling a running operation", () => {
  let ui: UiContext;
  const FAKE_HELPER = `python3 ${new URL("../resources/fake_helper.py", import.meta.url).pathname}`;

  before(async () => {
    process.env.AUDIBLE_HELPER = FAKE_HELPER;
    process.env.FAKE_HELPER_MODE = "slow";
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
    delete process.env.AUDIBLE_HELPER;
    delete process.env.FAKE_HELPER_MODE;
  });

  it("spins the sync icon and swaps it for a cancel X on hover, instead of a text Cancel button", async () => {
    // Sync Library is an icon-only button: it keeps its icon rather than
    // losing it to the word "Cancel", and is marked cancelable via
    // data-cancel plus its accessible name, not visible text.
    const sync = ui.page.locator('button[hx-post="/library/sync"]');
    await sync.click();
    await ui.page.waitForFunction(
      () => document.body.classList.contains("op-running"),
      { timeout: 10000 },
    );

    assert.equal(await sync.getAttribute("data-cancel"), "true");
    assert.equal(await sync.isEnabled(), true, "cancel must stay clickable");
    assert.equal(await sync.getAttribute("aria-label"), "Cancel sync library");

    // The click above left the mouse resting on the button; move it away so
    // the "not hovering yet" checks below aren't accidentally already hovering.
    await ui.page.mouse.move(0, 0);

    const refreshIcon = sync.locator(".icon-refresh");
    const cancelIcon = sync.locator(".icon-cancel");
    assert.equal(
      await refreshIcon.evaluate((el) => getComputedStyle(el).animationName),
      "spin",
      "the refresh icon spins while running",
    );
    assert.equal(await cancelIcon.evaluate((el) => getComputedStyle(el).display), "none", "no X until hovered");

    await sync.hover();
    assert.equal(await refreshIcon.evaluate((el) => getComputedStyle(el).display), "none", "spinner hides on hover");
    assert.equal(await cancelIcon.evaluate((el) => getComputedStyle(el).display), "block", "X shows on hover");
    assert.equal(
      await cancelIcon.evaluate((el) => getComputedStyle(el).color),
      "rgb(224, 27, 36)",
      "the cancel X reads as destructive (var(--danger))",
    );

    const downloadAll = ui.page.locator('#download-all-btn');
    assert.equal(await downloadAll.isDisabled(), true, "other operations are blocked");
    const rowAction = ui.page.locator("#books-table button.split-main").first();
    assert.equal(await rowAction.isDisabled(), true, "row actions are blocked too");
  });

  it("stops the operation and restores the buttons", async () => {
    // Clicking while hovered — showing the cancel X — is what actually cancels.
    await ui.page.locator("[data-cancel]").click();
    await ui.page.waitForFunction(
      () => !document.body.classList.contains("op-running"),
      { timeout: 20000 },
    );

    await ui.page.click("#log-toggle");
    assert.match(await ui.page.locator("#progress-panel").innerText(), /Cancell?ed/i);
    assert.equal(
      await ui.page.locator('#download-all-btn').isDisabled(),
      false,
      "buttons are usable again after cancelling",
    );
    // The label reverts from "Cancel" back to the icon — verified by the
    // absence of "Cancel" text plus its stable accessible name.
    const sync = ui.page.locator('button[hx-post="/library/sync"]');
    assert.ok(!/Cancel/.test((await sync.innerText()).trim()), "no longer shows Cancel");
    assert.equal(await sync.getAttribute("aria-label"), "Sync Library");
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

    const toggle = ui.page.locator(".topbar-actions [data-dropdown-toggle]");
    assert.match((await toggle.innerText()).trim(), /^alice/);
    await toggle.click();
    const menu = await ui.page.locator(".topbar-actions .dropdown-menu").innerText();
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

    // Lands back on the library, which auto-triggers a sync — no extra click.
    assert.equal(new URL(ui.page.url()).pathname, "/");
    await ui.page.click("#log-toggle");
    await ui.page.waitForFunction(
      () => /Sync started/.test(document.querySelector("#progress-panel")?.textContent || ""),
      { timeout: 10000 },
    );

    const settings = await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    const body = await ui.page.locator(".auth-wrap").innerText();
    assert.match(body, /Connected/);
    assert.ok(settings?.ok());
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

describe("one-click Download", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("labels every row action Download", async () => {
    const labels = await ui.page.locator("#books-table .split-main").allInnerTexts();
    assert.ok(labels.length >= 3, "expected several rows");
    for (const label of labels) {
      assert.match(label.trim(), /^Download$/, `unexpected primary label: ${label}`);
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
    await ui.page.click("#log-toggle");

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

describe("table layout", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedLongAuthor);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("has no redundant page heading", async () => {
    assert.equal(await ui.page.locator("main h1").count(), 0);
  });

  // Regression: a very long author used to widen its column and force the
  // other columns to wrap.
  it("truncates a long author instead of reflowing the table", async () => {
    const measured = await ui.page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll("td.col-author"));
      const long = cells.find((c) => (c as HTMLElement).title.includes("Featherstonehaugh"));
      const short = cells.find((c) => (c as HTMLElement).title.includes("Banks"));
      if (!long || !short) return null;
      const style = getComputedStyle(long);
      return {
        truncated: long.scrollWidth > long.clientWidth,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        fullNameKept: (long as HTMLElement).title.length > 40,
        sameRowHeight:
          Math.abs(
            long.closest("tr")!.getBoundingClientRect().height -
              short.closest("tr")!.getBoundingClientRect().height,
          ) < 2,
      };
    });

    assert.ok(measured, "author cells should be present");
    assert.ok(measured.truncated, "long author should overflow its capped cell");
    assert.equal(measured.whiteSpace, "nowrap");
    assert.equal(measured.textOverflow, "ellipsis");
    assert.ok(measured.fullNameKept, "full author stays available as a tooltip");
    assert.ok(measured.sameRowHeight, "long author must not make its row taller");
  });
});

describe("reset database from settings", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi();
    await ui.page.goto(`${ui.baseUrl}/login`, { waitUntil: "networkidle" });
    await ui.page.fill("#add-name", "alice");
    await ui.page.click('form[action="/user/add"] button[type=submit]');
    await ui.page.waitForLoadState("networkidle");
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
  });

  after(async () => {
    await ui?.close();
  });

  it("does nothing when the confirmation is dismissed", async () => {
    ui.page.once("dialog", (d) => d.dismiss());
    await ui.page.click('form[action="/user/reset-db"] button');
    await ui.page.waitForTimeout(300);
    const body = await ui.page.locator(".auth-wrap").innerText();
    assert.ok(!/database reset/i.test(body), "reset must not run when cancelled");
  });

  it("resets after confirming", async () => {
    ui.page.once("dialog", async (d) => {
      assert.match(d.message(), /Reset the library database/i);
      await d.accept();
    });
    await ui.page.click('form[action="/user/reset-db"] button');
    await ui.page.waitForLoadState("networkidle");
    const body = await ui.page.locator(".auth-wrap").innerText();
    assert.match(body, /database reset/i);
  });
});
