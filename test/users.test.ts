import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  addUser,
  getUser,
  listUsers,
  hasUsers,
  updateUser,
  verifyPassword,
  userHasPassword,
  userDirs,
  runWithUser,
  currentUserName,
  setColumnPrefs,
} from "../src/users.ts";
import { closeDb, markDownloaded, getAllAudiobooks } from "../src/db.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "users-test-"));
  process.env.USERS_DIR = path.join(tmpDir, "users");
  delete process.env.DB_PATH;
  closeDb();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("user registry", () => {
  it("starts empty and registers users with their directories", () => {
    assert.equal(hasUsers(), false);
    addUser("alice");
    assert.equal(hasUsers(), true);
    assert.deepEqual(listUsers().map((u) => u.name), ["alice"]);

    const dirs = userDirs("alice");
    assert.ok(fs.existsSync(dirs.targetDir), "aax dir created");
    assert.ok(fs.existsSync(dirs.outputDir), "converted dir created");
    assert.ok(fs.existsSync(dirs.authDir), "audible auth dir created");
  });

  it("rejects invalid and duplicate names", () => {
    assert.throws(() => addUser("has space"));
    assert.throws(() => addUser("../escape"));
    assert.throws(() => addUser(""));
    addUser("bob");
    assert.throws(() => addUser("bob"));
    assert.throws(() => addUser("BOB"), /already exists/);
  });

  it("stores optional activation bytes", () => {
    addUser("carol", undefined, "1a2b3c4d");
    assert.equal(getUser("carol")?.activationBytes, "1a2b3c4d");
    addUser("dave");
    assert.equal(getUser("dave")?.activationBytes, undefined);
  });
});

describe("passwords", () => {
  it("hashes and verifies optional passwords", () => {
    addUser("secure", "hunter2");
    const user = getUser("secure")!;
    assert.equal(userHasPassword(user), true);
    assert.ok(!JSON.stringify(listUsers()).includes("hunter2"), "no plaintext stored");
    assert.equal(verifyPassword(user, "hunter2"), true);
    assert.equal(verifyPassword(user, "wrong"), false);
  });

  it("passwordless users always verify", () => {
    addUser("open");
    const user = getUser("open")!;
    assert.equal(userHasPassword(user), false);
    assert.equal(verifyPassword(user, ""), true);
  });

  it("updates and removes passwords", () => {
    addUser("changer", "old");
    updateUser("changer", { password: "new" });
    assert.equal(verifyPassword(getUser("changer")!, "new"), true);
    assert.equal(verifyPassword(getUser("changer")!, "old"), false);

    updateUser("changer", { removePassword: true });
    assert.equal(userHasPassword(getUser("changer")!), false);
  });
});

describe("per-user database isolation", () => {
  it("each user context reads and writes its own database", () => {
    addUser("alice");
    addUser("bob");

    runWithUser("alice", () => {
      markDownloaded("B000000001", "Author A", "Alice's Book", "/a.aax");
    });

    const aliceBooks = runWithUser("alice", () => getAllAudiobooks());
    const bobBooks = runWithUser("bob", () => getAllAudiobooks());
    assert.equal(aliceBooks.length, 1);
    assert.equal(bobBooks.length, 0);

    assert.ok(fs.existsSync(userDirs("alice").dbPath), "alice db file exists");
  });

  it("context propagates through async chains", async () => {
    addUser("async-user");
    const name = await runWithUser("async-user", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentUserName();
    });
    assert.equal(name, "async-user");
    assert.equal(currentUserName(), undefined);
  });
});

describe("column prefs", () => {
  it("saves and reads back a user's books-table column choices", () => {
    addUser("alice");
    assert.equal(getUser("alice")?.columnPrefs, undefined, "nothing saved yet");

    setColumnPrefs("alice", { hidden: ["asin", "format"], order: ["title", "author"] });
    assert.deepEqual(getUser("alice")?.columnPrefs, {
      hidden: ["asin", "format"],
      order: ["title", "author"],
    });
  });

  it("survives the same round trip a fresh process would see (persisted to disk)", () => {
    addUser("alice");
    setColumnPrefs("alice", { hidden: ["asin"], order: [] });
    // listUsers() re-reads users.json from disk rather than any in-memory
    // cache, so this stands in for "the app restarted".
    assert.deepEqual(listUsers().find((u) => u.name === "alice")?.columnPrefs, {
      hidden: ["asin"],
      order: [],
    });
  });

  it("rejects an unknown user", () => {
    assert.throws(() => setColumnPrefs("nobody", { hidden: [], order: [] }), /Unknown user/);
  });
});
