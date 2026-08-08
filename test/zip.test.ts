import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { zipStream, zipDirectoryEntries } from "../src/web/zip.ts";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-test-"));
  fs.writeFileSync(path.join(tmpDir, "01 - Intro.mp3"), "fake mp3 data one");
  fs.writeFileSync(path.join(tmpDir, "02 - Chapter.mp3"), "fake mp3 data two, longer");
  fs.writeFileSync(path.join(tmpDir, "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function collect(entries: ReturnType<typeof zipDirectoryEntries>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(entries)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function hasPython3(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("zipDirectoryEntries", () => {
  it("lists all files with archive-relative paths, sorted", () => {
    const entries = zipDirectoryEntries(tmpDir);
    assert.deepEqual(
      entries.map((e) => e.archivePath),
      ["01 - Intro.mp3", "02 - Chapter.mp3", "cover.jpg"],
    );
  });
});

describe("zipStream", () => {
  it("produces a buffer with ZIP local header and EOCD signatures", async () => {
    const zip = await collect(zipDirectoryEntries(tmpDir));

    assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature");
    const eocd = zip.subarray(zip.length - 22);
    assert.equal(eocd.readUInt32LE(0), 0x06054b50, "end of central directory signature");
    assert.equal(eocd.readUInt16LE(10), 3, "entry count in EOCD");
  });

  it("round-trips through a real ZIP reader", { skip: !hasPython3() }, async () => {
    const zip = await collect(zipDirectoryEntries(tmpDir));
    const zipFile = path.join(tmpDir, "..", `zip-test-out-${process.pid}.zip`);
    fs.writeFileSync(zipFile, zip);

    try {
      const output = execFileSync(
        "python3",
        [
          "-c",
          "import zipfile,sys\n" +
            "z = zipfile.ZipFile(sys.argv[1])\n" +
            "assert z.testzip() is None, 'CRC mismatch'\n" +
            "print('|'.join(sorted(z.namelist())))\n" +
            "print(z.read('01 - Intro.mp3').decode())",
          zipFile,
        ],
        { encoding: "utf8" },
      );
      const [names, content] = output.trim().split("\n");
      assert.equal(names, "01 - Intro.mp3|02 - Chapter.mp3|cover.jpg");
      assert.equal(content, "fake mp3 data one");
    } finally {
      fs.rmSync(zipFile, { force: true });
    }
  });
});
