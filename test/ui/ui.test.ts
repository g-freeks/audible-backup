import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import {
  startUi,
  seedBooks,
  seedManyBooks,
  seedLongAuthor,
  type UiContext,
} from "./fixture.ts";

/**
 * Browser tests. Every case here covers a failure mode that route-level
 * (JSON API) tests structurally cannot catch: the React client actually
 * mounting under the strict CSP, drag-and-drop (dnd-kit uses pointer events,
 * not native HTML5 DnD — Playwright's dragTo() does not trigger it, so
 * these use manual mouse sequences via dragBetween() below), SSE-driven UI
 * updates, and Base UI's portaled Menu/Popover components actually
 * rendering visible and clickable.
 */

/** Manual pointer-based drag: dnd-kit's PointerSensor needs real
 * mousedown/mousemove/mouseup, not the native dragstart/dragover/drop
 * sequence Locator.dragTo() simulates. */
async function dragBetween(page: Page, from: Locator, to: Locator): Promise<void> {
  const fromBox = await from.boundingBox();
  const toBox = await to.boundingBox();
  if (!fromBox || !toBox) throw new Error("drag source/target not visible");
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** Creates a user through the real login UI and lands back on the library. */
async function createUser(page: Page, baseUrl: string, name: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.fill("#add-name", name);
  await page.click('button:has-text("Create user")');
  await page.waitForSelector(".topbar");
}

describe("library page in a browser", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("loads with no console errors and no CSP violations", () => {
    const csp = ui.consoleErrors.filter((e) => /Content Security Policy/i.test(e));
    assert.deepEqual(csp, [], "CSP must not block our own scripts");
    assert.deepEqual(ui.consoleErrors, [], "no console errors on load");
  });

  it("opens a row's action menu and closes it with Escape", async () => {
    const caret = ui.page.locator("#books-table .split-caret").first();
    await caret.click();
    await ui.page.locator(".dropdown-menu[data-open]").waitFor({ timeout: 3000 });
    assert.equal(await ui.page.locator(".dropdown-menu[data-open]").count(), 1);

    await ui.page.keyboard.press("Escape");

    await ui.page.waitForTimeout(200);
    assert.equal(await ui.page.locator(".dropdown-menu[data-open]").count(), 0);
  });

  it("filters rows via the search box", async () => {
    await ui.page.fill("#search-input", "dune");
    await ui.page.waitForTimeout(150);
    assert.equal(await ui.page.locator("#books-table tbody tr").count(), 1);
    await ui.page.fill("#search-input", "");
    await ui.page.waitForTimeout(150);
    assert.equal(await ui.page.locator("#books-table tbody tr").count(), 3);
  });

  it("sorts columns on click", async () => {
    const header = ui.page.locator("#books-table thead th.sortable").first();
    await header.click();
    assert.match((await header.getAttribute("class")) || "", /\basc\b/);
    await header.click();
    assert.match((await header.getAttribute("class")) || "", /\bdesc\b/);
  });
});

describe("column reorder and visibility, persisted per account", () => {
  let ui: UiContext;

  /** Seeds one book directly into the given account's own per-user database,
   * before the server starts, since this runs in the test process. */
  function seedUserBook(userName: string) {
    return async (env: NodeJS.ProcessEnv) => {
      const prevUsersDir = process.env.USERS_DIR;
      const prevDbPath = process.env.DB_PATH;
      process.env.USERS_DIR = env.USERS_DIR;
      const users = await import("../../src/users.ts");
      const db = await import("../../src/db.ts");
      const fs = await import("node:fs");
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
    await createUser(ui.page, ui.baseUrl, "alice");
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("reorders columns by dragging a header, and it survives a reload", async () => {
    const headerText = async () =>
      (await ui.page.locator("#books-table thead th").allInnerTexts()).map((t) => t.trim().toLowerCase());

    const before = await headerText();
    assert.match(before[1], /^title/);

    const asinHeader = ui.page.locator("#books-table thead th", { hasText: "ASIN" });
    const titleHeader = ui.page.locator("#books-table thead th", { hasText: "Title" });
    await dragBetween(ui.page, asinHeader, titleHeader);
    await ui.page.waitForTimeout(200);

    const reordered = await headerText();
    assert.match(reordered[1], /^asin/, "ASIN dropped in front of Title");

    // Persisted via POST /api/table-state (debounced 500ms) — wait past it.
    await ui.page.waitForTimeout(600);
    await ui.page.reload({ waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
    assert.match((await headerText())[1], /^asin/, "order survives a reload");
  });

  it("hides and re-shows a column from the Columns menu, and it survives a reload", async () => {
    await ui.page.click('button:has-text("Columns")');
    const asinToggle = ui.page.locator('.dropdown-menu [role="menuitemcheckbox"]', { hasText: "ASIN" });
    assert.equal(await asinToggle.getAttribute("data-checked"), "");

    await asinToggle.click();
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
    assert.equal(await ui.page.locator('#books-table thead th', { hasText: "ASIN" }).count(), 0);

    await ui.page.waitForTimeout(600);
    await ui.page.reload({ waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
    assert.equal(
      await ui.page.locator('#books-table thead th', { hasText: "ASIN" }).count(),
      0,
      "hidden column stays hidden across a reload",
    );

    // Re-show it so it doesn't affect anything running after this in the
    // same worker.
    await ui.page.click('button:has-text("Columns")');
    await ui.page.locator('.dropdown-menu [role="menuitemcheckbox"]', { hasText: "ASIN" }).click();
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
  });
});

describe("table state survives a wiped browser (e.g. the desktop app's port changing every launch)", () => {
  let ui: UiContext;

  function seedUserBook(userName: string) {
    return async (env: NodeJS.ProcessEnv) => {
      const prevUsersDir = process.env.USERS_DIR;
      const prevDbPath = process.env.DB_PATH;
      process.env.USERS_DIR = env.USERS_DIR;
      const users = await import("../../src/users.ts");
      const db = await import("../../src/db.ts");
      const fs = await import("node:fs");
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
    await createUser(ui.page, ui.baseUrl, "alice");
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("hides a column, then recovers it in a brand-new browser context signed into the same account", async () => {
    await ui.page.click('button:has-text("Columns")');
    await ui.page.locator('.dropdown-menu [role="menuitemcheckbox"]', { hasText: "ASIN" }).click();
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
    // The save to the account is debounced — give it a moment to land.
    await ui.page.waitForTimeout(600);

    // A brand-new context has no cookies and no localStorage at all.
    const browser = ui.page.context().browser();
    if (!browser) throw new Error("expected a browser instance");
    const freshContext = await browser.newContext();
    try {
      const freshPage = await freshContext.newPage();
      await freshPage.goto(`${ui.baseUrl}/login`, { waitUntil: "networkidle" });
      await freshPage.click('button:has-text("Continue as alice")');
      await freshPage.waitForSelector("#books-table");

      assert.equal(
        await freshPage.locator('#books-table thead th', { hasText: "ASIN" }).count(),
        0,
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
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("stays disabled until a book is checked, and disables again once cleared", async () => {
    const btn = ui.page.locator("#download-selected-btn");
    assert.equal(await btn.isDisabled(), true);

    const checkbox = ui.page.locator('#books-table tbody input[type="checkbox"]').first();
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
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("keeps the log closed until the user opens it, lighting only the topbar indicator", async () => {
    assert.equal(await ui.page.locator("#log-float.visible").count(), 0);

    await ui.page.click("#sync-library-btn");
    await ui.page.waitForFunction(
      () => document.getElementById("log-indicator") !== null,
      { timeout: 10000 },
    );

    assert.equal(await ui.page.locator("#log-float.visible").count(), 0, "an operation must not pop the log open");
  });

  it("opens from the topbar and shows the streamed log", async () => {
    await ui.page.click("#log-toggle");
    assert.equal(await ui.page.locator("#log-float.visible").count(), 1);
    assert.equal(await ui.page.locator("#log-toggle").getAttribute("aria-expanded"), "true");

    await ui.page.waitForFunction(
      () => (document.querySelectorAll("#progress-panel .log-line").length || 0) > 0,
      { timeout: 15000 },
    );
    const text = await ui.page.locator("#progress-panel").innerText();
    assert.match(text, /Fetching library|Not signed in|Audible/i);
  });

  it("closes again from its own close button", async () => {
    await ui.page.click("#log-float-close");
    assert.equal(await ui.page.locator("#log-float.visible").count(), 0);
    assert.equal(await ui.page.locator("#log-toggle").getAttribute("aria-expanded"), "false");
  });

  it("shows Download All output in the same panel", async () => {
    await ui.page.reload({ waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
    await ui.page.click("#download-all-btn");
    await ui.page.click('.confirm-popup button:has-text("OK")');
    await ui.page.click("#log-toggle");
    await ui.page.waitForFunction(
      () => (document.querySelectorAll("#progress-panel .log-line").length || 0) > 0,
      { timeout: 10000 },
    );
    assert.ok((await ui.page.locator("#progress-panel").innerText()).length > 0);
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
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
    delete process.env.AUDIBLE_HELPER;
    delete process.env.FAKE_HELPER_MODE;
  });

  it("spins the sync icon and swaps it for a cancel X on hover, disabling other actions", async () => {
    const sync = ui.page.locator("#sync-library-btn");
    await sync.click();
    await ui.page.waitForFunction(
      () => document.getElementById("sync-library-btn")?.getAttribute("data-cancel") === "true",
      { timeout: 10000 },
    );

    assert.equal(await sync.isEnabled(), true, "cancel must stay clickable");
    assert.equal(await sync.getAttribute("aria-label"), "Cancel sync library");

    await ui.page.mouse.move(0, 0);
    assert.equal(
      await sync.locator(".icon-refresh").evaluate((el) => getComputedStyle(el).animationName),
      "spin",
      "the refresh icon spins while running",
    );
    assert.equal(
      await sync.locator(".icon-cancel").evaluate((el) => getComputedStyle(el).display),
      "none",
      "no X until hovered",
    );

    await sync.hover();
    assert.equal(await sync.locator(".icon-refresh").evaluate((el) => getComputedStyle(el).display), "none");
    assert.equal(await sync.locator(".icon-cancel").evaluate((el) => getComputedStyle(el).display), "block");

    assert.equal(await ui.page.locator("#download-all-btn").isDisabled(), true, "other operations are blocked");
    const rowBtn = ui.page.locator("#books-table tbody tr", { hasText: "Snow Crash" }).locator(".split-main");
    assert.equal(await rowBtn.isDisabled(), true, "row actions are blocked too");
  });

  it("stops the operation and restores the buttons", async () => {
    await ui.page.locator("[data-cancel]").click();
    await ui.page.waitForFunction(
      () => document.getElementById("sync-library-btn")?.getAttribute("data-cancel") === null,
      { timeout: 20000 },
    );

    await ui.page.click("#log-toggle");
    assert.match(await ui.page.locator("#progress-panel").innerText(), /Cancell?ed/i);
    assert.equal(
      await ui.page.locator("#download-all-btn").isDisabled(),
      false,
      "buttons are usable again after cancelling",
    );
    assert.equal(await ui.page.locator("#sync-library-btn").getAttribute("aria-label"), "Sync Library");
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
    await createUser(ui.page, ui.baseUrl, "alice");

    const toggle = ui.page.locator(".topbar-actions button", { hasText: "alice" });
    await toggle.click();
    const menu = await ui.page.locator(".dropdown-menu[data-open]").innerText();
    for (const entry of ["Settings", "Add user", "Sign out"]) {
      assert.match(menu, new RegExp(entry));
    }
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
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
    await createUser(ui.page, ui.baseUrl, "alice");
  });

  after(async () => {
    await ui?.close();
    delete process.env.AUDIBLE_HELPER;
  });

  it("walks the two-step flow to a connected account", async () => {
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    await ui.page.selectOption("#marketplace", "de");
    await ui.page.click('button:has-text("Start sign-in")');
    await ui.page.waitForSelector("#redirect-url");

    const signinHref = await ui.page.locator(".auth-card a[target=_blank]").getAttribute("href");
    assert.match(signinHref || "", /amazon\.de\/ap\/signin/);

    await ui.page.fill("#redirect-url", "https://www.audible.de/?openid.oa2.authorization_code=ABC123");
    await ui.page.click('button:has-text("Finish sign-in")');

    // Lands back on Settings reporting connected, and a sync auto-started
    // (see the ?sync=1 comment in the old form flow this replaces) — against
    // the fake helper it completes almost immediately, so the reliable check
    // is the outcome (the synced book shows up), not catching an in-progress
    // log line.
    await ui.page.waitForSelector("text=Connected");
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table tbody tr", { timeout: 10000 });
    assert.match(await ui.page.locator("#books-table").innerText(), /Fake Book/);

    assert.deepEqual(
      ui.consoleErrors.filter((e) => /Content Security Policy/i.test(e)),
      [],
    );
  });
});

describe("conversion quality settings", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi();
    await createUser(ui.page, ui.baseUrl, "alice");
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    await ui.page.click('button:has-text("Output")');
  });

  after(async () => {
    await ui?.close();
  });

  it("clicking a format button updates the args field and its own selected state", async () => {
    const argsInput = ui.page.locator("#audio-args");
    assert.match(await argsInput.inputValue(), /libmp3lame/, "starts on the mp3 default");

    await ui.page.click('button:has-text("FLAC")');
    assert.match(await argsInput.inputValue(), /flac/);
    assert.equal(await ui.page.locator('button:has-text("FLAC")').getAttribute("aria-pressed"), "true");
    assert.equal(await ui.page.locator('button:has-text("MP3")').getAttribute("aria-pressed"), "false");
  });

  it("clicking a quality button updates the args field", async () => {
    await ui.page.click('button:has-text("AAC")');
    await ui.page.click('button:has-text("High")');

    const argsInput = ui.page.locator("#audio-args");
    assert.equal(await argsInput.inputValue(), "-c:a aac -b:a 192k");
  });

  it("the args field stays disabled until the switch is turned on", async () => {
    const argsInput = ui.page.locator("#audio-args");
    assert.equal(await argsInput.isDisabled(), true);

    // The native checkbox is visually hidden — click the visible switch,
    // the way a real user (and its wrapping <label>) would.
    await ui.page.click(".switch-root");
    assert.equal(await argsInput.isDisabled(), false);

    await argsInput.fill("-c:a libmp3lame -q:a 0");
    await ui.page.click('.tab-panel:not([hidden]) button:has-text("Save")');
    await ui.page.waitForSelector("text=Settings saved");

    assert.equal(await ui.page.locator("#audio-args").inputValue(), "-c:a libmp3lame -q:a 0");
    assert.equal(await ui.page.locator("#audio-args").isDisabled(), false);
  });
});

describe("output naming builder", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi();
    await createUser(ui.page, ui.baseUrl, "alice");
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    await ui.page.click('button:has-text("Output")');
  });

  after(async () => {
    await ui?.close();
  });

  function directoryRow(index: number) {
    return ui.page.locator(`#directory-rows .format-row:nth-child(${index + 1})`);
  }

  it("starts with the default (Title-only, single folder) template and a matching preview", async () => {
    assert.equal(await ui.page.locator("#directory-rows .format-row").count(), 1);
    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Title"]);
    assert.deepEqual(
      await ui.page.locator("#filename-row .format-chip-label").allInnerTexts(),
      ["Chapter #", "Chapter Name"],
    );
    assert.equal(await ui.page.locator("#format-preview").innerText(), "The Final Empire / 01 - Prologue.mp3");
  });

  it("adding a tag via the row's select appends a chip and updates the preview live", async () => {
    await directoryRow(0).locator(".format-add-tag").selectOption("author");
    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Title", "Author"]);
    assert.match(await ui.page.locator("#format-preview").innerText(), /The Final EmpireBrandon Sanderson/);
  });

  it("+ Add folder level adds a new, independently-removable row", async () => {
    await ui.page.click("#add-folder-level");
    assert.equal(await ui.page.locator("#directory-rows .format-row").count(), 2);

    await directoryRow(1).locator(".format-add-tag").selectOption("series");
    assert.deepEqual(await directoryRow(1).locator(".format-chip-label").allInnerTexts(), ["Series"]);

    await directoryRow(1).locator(".format-remove-row").click();
    assert.equal(await ui.page.locator("#directory-rows .format-row").count(), 1);
    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Title", "Author"]);
  });

  it("+ Text adds an editable literal block that flows into the preview as typed", async () => {
    await directoryRow(0).locator(".format-add-text").click();
    const textInput = directoryRow(0).locator(".chip-text-input");
    await textInput.fill(" -- ");
    assert.match(await ui.page.locator("#format-preview").innerText(), /Brandon Sanderson --/);
  });

  it("removing a chip drops it from the row and the preview", async () => {
    await directoryRow(0).locator(".chip-remove").nth(2).click();
    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Title", "Author"]);
    assert.match(await ui.page.locator("#format-preview").innerText(), /The Final EmpireBrandon Sanderson/);
  });

  it("dragging a chip onto another reorders within the row", async () => {
    const authorChip = directoryRow(0).locator(".format-chip", { hasText: "Author" });
    const titleChip = directoryRow(0).locator(".format-chip", { hasText: "Title" });
    await dragBetween(ui.page, authorChip, titleChip);
    await ui.page.waitForTimeout(150);
    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Author", "Title"]);
  });

  it("dragging a chip into a different row moves it there", async () => {
    await ui.page.click("#add-folder-level");
    const newRowIndex = (await ui.page.locator("#directory-rows .format-row").count()) - 1;
    const newRow = directoryRow(newRowIndex);

    const titleChip = directoryRow(0).locator(".format-chip", { hasText: "Title" });
    await dragBetween(ui.page, titleChip, newRow.locator(".format-blocks"));
    await ui.page.waitForTimeout(150);

    assert.deepEqual(await directoryRow(0).locator(".format-chip-label").allInnerTexts(), ["Author"]);
    assert.deepEqual(await newRow.locator(".format-chip-label").allInnerTexts(), ["Title"]);
  });

  it("dragging a folder level's grip handle reorders the levels", async () => {
    const beforeOrder = await ui.page.locator("#directory-rows .format-row").evaluateAll((rows) =>
      rows.map((r) => Array.from(r.querySelectorAll(".format-chip-label")).map((c) => c.textContent)),
    );
    const firstGrip = directoryRow(0).locator(".format-row-grip");
    const lastGrip = ui.page.locator("#directory-rows .format-row").last().locator(".format-row-grip");
    await dragBetween(ui.page, firstGrip, lastGrip);
    await ui.page.waitForTimeout(150);

    const afterOrder = await ui.page.locator("#directory-rows .format-row").evaluateAll((rows) =>
      rows.map((r) => Array.from(r.querySelectorAll(".format-chip-label")).map((c) => c.textContent)),
    );
    assert.notDeepEqual(afterOrder, beforeOrder, "the level order actually changed");
    assert.deepEqual(afterOrder[afterOrder.length - 1], beforeOrder[0], "the dragged level landed at the end");
  });

  it("saves the built template and reloads it exactly as left", async () => {
    const before = await ui.page.locator("#directory-rows .format-row").evaluateAll((rows) =>
      rows.map((r) => Array.from(r.querySelectorAll(".format-chip-label")).map((c) => c.textContent)),
    );
    await ui.page.click('.tab-panel:not([hidden]) button:has-text("Save")');
    await ui.page.waitForSelector("text=Settings saved");
    await ui.page.reload({ waitUntil: "networkidle" });
    await ui.page.click('button:has-text("Output")');

    const after = await ui.page.locator("#directory-rows .format-row").evaluateAll((rows) =>
      rows.map((r) => Array.from(r.querySelectorAll(".format-chip-label")).map((c) => c.textContent)),
    );
    assert.deepEqual(after, before);
  });
});

describe("row action menus in a long table", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedManyBooks);
    await ui.page.setViewportSize({ width: 1280, height: 700 });
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("opens and closes a row's menu with the caret", async () => {
    const caret = ui.page.locator("#books-table tbody tr").first().locator(".split-caret");
    await caret.click();
    await ui.page.locator(".dropdown-menu[data-open]").waitFor({ timeout: 3000 });
    assert.equal(await ui.page.locator(".dropdown-menu[data-open]").count(), 1);
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
    assert.equal(await ui.page.locator(".dropdown-menu[data-open]").count(), 0);
  });

  it("keeps a menu fully within the viewport even for a row near the bottom", async () => {
    const rows = ui.page.locator("#books-table tbody tr");
    const lastCaret = rows.last().locator(".split-caret");
    await lastCaret.scrollIntoViewIfNeeded();
    await lastCaret.click();
    await ui.page.locator(".dropdown-menu[data-open]").waitFor({ timeout: 3000 });

    const box = await ui.page.locator(".dropdown-menu[data-open]").boundingBox();
    const viewport = ui.page.viewportSize();
    assert.ok(box && viewport, "menu should be open");
    assert.ok(box!.y >= 0 && box!.y + box!.height <= viewport!.height + 1, "menu must be fully within the viewport");
    await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(200);
  });
});

describe("one-click Download", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
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

  it("queues and reports failure for a book that cannot really be fetched here", async () => {
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
    const row = ui.page.locator("#books-table tbody tr", { hasText: "Snow Crash" });
    await row.locator(".split-main").click();
    await ui.page.click("#log-toggle");

    await ui.page.waitForFunction(
      () => /log-done/.test(document.querySelector("#progress-panel")?.innerHTML || ""),
      { timeout: 20000 },
    );
    const panel = await ui.page.locator("#progress-panel").innerText();
    assert.match(panel, /Preparing|Downloading|Failed|Could not|not found/i);
  });
});

describe("search field", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedBooks);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
  });

  after(async () => {
    await ui?.close();
  });

  it("hides the clear button until there is text", async () => {
    assert.equal(await ui.page.locator("#search-clear").count(), 0);
    await ui.page.fill("#search-input", "dune");
    assert.equal(await ui.page.locator("#search-clear").count(), 1);
  });

  it("clears the text and restores all rows", async () => {
    await ui.page.fill("#search-input", "dune");
    assert.equal(await ui.page.locator("#books-table tbody tr").count(), 1);

    await ui.page.click("#search-clear");
    assert.equal(await ui.page.inputValue("#search-input"), "");
    assert.equal(await ui.page.locator("#books-table tbody tr").count(), 3);
    assert.equal(await ui.page.locator("#search-clear").count(), 0);
  });
});

describe("table layout", () => {
  let ui: UiContext;

  before(async () => {
    ui = await startUi(seedLongAuthor);
    await ui.page.goto(ui.baseUrl, { waitUntil: "networkidle" });
    await ui.page.waitForSelector("#books-table");
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
    await createUser(ui.page, ui.baseUrl, "alice");
    await ui.page.goto(`${ui.baseUrl}/user/settings`, { waitUntil: "networkidle" });
    await ui.page.click('button:has-text("Debug")');
  });

  after(async () => {
    await ui?.close();
  });

  it("does nothing when the confirmation is cancelled", async () => {
    await ui.page.click('button:has-text("Reset database")');
    await ui.page.waitForSelector(".confirm-popup");
    await ui.page.click('.confirm-popup button:has-text("Cancel")');
    await ui.page.locator(".confirm-popup").waitFor({ state: "detached", timeout: 3000 });
    assert.equal(await ui.page.locator("#toast-region").innerText(), "", "reset must not run when cancelled");
  });

  it("resets after confirming", async () => {
    await ui.page.click('button:has-text("Reset database")');
    await ui.page.waitForSelector(".confirm-popup");
    assert.match(await ui.page.locator(".confirm-popup").innerText(), /Reset the library database/i);
    await ui.page.click('.confirm-popup button:has-text("OK")');
    await ui.page.waitForSelector("text=/database reset/i");
  });
});
