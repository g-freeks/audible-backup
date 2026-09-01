import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AudibleLibrary, describeAudibleCliError } from "../src/library.ts";
import { closeDb, getDownloadedAsins } from "../src/db.ts";

let dbDir: string;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-db-"));
  process.env.DB_PATH = path.join(dbDir, "test.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("AudibleLibrary constructor", () => {
  it("creates target directory if it does not exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    const targetDir = path.join(tmp, "nested", "dir");
    new AudibleLibrary(targetDir);
    assert.ok(fs.existsSync(targetDir));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves tilde in directory path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    const library = new AudibleLibrary(tmp);
    assert.ok(!library.targetDir.includes("~"));
    assert.ok(path.isAbsolute(library.targetDir));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("starts with empty database when directory is empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-"));
    new AudibleLibrary(tmp);
    assert.equal(getDownloadedAsins().size, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("AudibleLibrary.importExistingFiles", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-asins-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports aax files into database", () => {
    fs.writeFileSync(path.join(tmpDir, "B001234567_title.aax"), "");
    fs.writeFileSync(path.join(tmpDir, "B009876543_other.aax"), "");
    new AudibleLibrary(tmpDir);
    const asins = getDownloadedAsins();
    assert.equal(asins.size, 2);
    assert.ok(asins.has("B001234567"));
    assert.ok(asins.has("B009876543"));
  });

  it("ignores non-aax files", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-nonaax-"));
    fs.writeFileSync(path.join(tmp, "B001234567_title.mp3"), "");
    fs.writeFileSync(path.join(tmp, "readme.txt"), "");
    new AudibleLibrary(tmp);
    assert.equal(getDownloadedAsins().size, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds aax files in subdirectories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-nested-"));
    const subDir = path.join(tmp, "subdir");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, "B005555555_nested.aax"), "");
    new AudibleLibrary(tmp);
    assert.ok(getDownloadedAsins().has("B005555555"));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("AudibleLibrary.ensureTargetDirectory", () => {
  it("creates directory recursively", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-ensure-"));
    const nested = path.join(tmp, "a", "b", "c");
    new AudibleLibrary(nested);
    assert.ok(fs.existsSync(nested));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("does not throw if directory already exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lib-exists-"));
    assert.doesNotThrow(() => new AudibleLibrary(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("describeAudibleCliError", () => {
  it("explains a missing audible-cli binary", () => {
    const msg = describeAudibleCliError(new Error("/bin/sh: 1: audible: not found"));
    assert.match(msg, /not installed or not on PATH/);
    assert.match(msg, /pipx install audible-cli/);
  });

  it("points at the working sign-in flow for auth failures", () => {
    // Signing in used to be a command-line step. It is a page in the app now,
    // so the error must not send people to a tool the image no longer ships.
    const msg = describeAudibleCliError(new Error("no profile found in config"));
    assert.match(msg, /sign-in required/i);
    assert.match(msg, /Connect Audible/);
    assert.ok(!/quickstart/.test(msg), "must not point at audible quickstart");
  });

  it("falls back to the raw error otherwise", () => {
    const msg = describeAudibleCliError(new Error("kaboom"));
    assert.match(msg, /Failed to get library list/);
    assert.match(msg, /kaboom/);
  });
});
