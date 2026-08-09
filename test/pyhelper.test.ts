import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { runHelper, HelperUnavailableError, type HelperEvent } from "../src/pyhelper.ts";
import { AudibleLibrary } from "../src/library.ts";
import { closeDb, getAudiobookByAsin, upsertBook } from "../src/db.ts";

const FAKE_HELPER = `python3 ${path.resolve(import.meta.dirname, "resources", "fake_helper.py")}`;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pyhelper-test-"));
  process.env.DB_PATH = path.join(tmpDir, "test.db");
  process.env.USERS_DIR = path.join(tmpDir, "users");
  process.env.AUDIBLE_HELPER = FAKE_HELPER;
  delete process.env.FAKE_HELPER_MODE;
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.AUDIBLE_HELPER;
  delete process.env.FAKE_HELPER_MODE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("runHelper", () => {
  it("returns the done event and forwards intermediate events", async () => {
    const events: HelperEvent[] = [];
    const done = await runHelper(["library"], (ev) => events.push(ev));
    assert.equal(done.ok, true);
    assert.equal((done.items as unknown[]).length, 2);
    assert.equal(events[0].type, "log");
  });

  it("throws HelperUnavailableError for missing dependencies", async () => {
    process.env.FAKE_HELPER_MODE = "missing";
    await assert.rejects(runHelper(["library"]), HelperUnavailableError);
  });

  it("throws HelperUnavailableError when the command cannot start", async () => {
    process.env.AUDIBLE_HELPER = "/nonexistent/binary-xyz";
    await assert.rejects(runHelper(["library"]), HelperUnavailableError);
  });
});

describe("AudibleLibrary with helper", () => {
  function makeLibrary(): AudibleLibrary {
    const target = path.join(tmpDir, "aax");
    fs.mkdirSync(target, { recursive: true });
    return new AudibleLibrary(target, { log() {}, error() {}, warn() {} });
  }

  it("lists the library via the helper, filtering non-downloadable items", async () => {
    const library = makeLibrary();
    const entries = await library.getLibraryList();
    assert.deepEqual(entries.map((e) => e.asin), ["B0FAKE00001"]);
    assert.equal(entries[0].author, "Fake Author");
    assert.equal(entries[0].title, "Fake Book");
  });

  it("downloads AAXC via the helper and records the real path", async () => {
    const library = makeLibrary();
    const ok = await library.downloadBook("B0FAKE00001", "Fake Author", "Fake Book");
    assert.equal(ok, true);
    const row = getAudiobookByAsin("B0FAKE00001");
    assert.ok(row?.downloaded_at, "marked downloaded");
    assert.ok(row?.aax_path?.endsWith(".aaxc"), `aaxc path recorded: ${row?.aax_path}`);
    assert.ok(fs.existsSync(row!.aax_path!), "aaxc file exists");
  });

  it("marks books not downloadable when the license is denied", async () => {
    process.env.FAKE_HELPER_MODE = "not_downloadable";
    const library = makeLibrary();
    upsertBook("B0FAKE00009", "A", "Denied Book");
    const ok = await library.downloadBook("B0FAKE00009", "A", "Denied Book");
    assert.equal(ok, false);
    const row = getAudiobookByAsin("B0FAKE00009");
    assert.ok(row?.not_downloadable_at, "flagged not downloadable");
  });
});

describe("helper library request", () => {
  // Regression: the library call omitted the 'contributors' response group,
  // so the Audible API returned no authors and the Author column was always
  // empty. Guarded at the source because the real call needs credentials.
  it("asks Audible for the contributors response group", async () => {
    const source = await fs.promises.readFile(
      path.resolve(import.meta.dirname, "..", "helper", "audible_helper.py"),
      "utf8",
    );
    const call = source.slice(source.indexOf("def cmd_library"));
    const groups = call.match(/response_groups="([^"]+)"/);
    assert.ok(groups, "library call should set response_groups");
    assert.match(groups[1], /contributors/, "authors come from 'contributors'");
  });
});
