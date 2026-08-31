import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * The desktop integration is mostly data files, and the ways they break are
 * silent: an app ID that stops matching its filenames, a screenshot URL that
 * points at nothing, an icon that was never re-rendered after the SVG changed.
 * None of that shows up when running the app, only when a Flatpak build or a
 * store listing is produced — so it is checked here instead.
 */

const APP_ID = "io.github.g_freeks.audible_backup";
const ROOT = path.resolve(import.meta.dirname, "..");
const DESKTOP = path.join(ROOT, "desktop");
const RAW_PREFIX =
  "https://raw.githubusercontent.com/g-freeks/audible-backup/main/";

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(DESKTOP, ...parts), "utf8");
}

// --- Minimal XML support ---
// A real parser is overkill for one hand-written file, but the checks below
// need both well-formedness and element lookup, so tags are walked once into
// a tree. Mismatched or unclosed tags throw, which is the point.

interface Node {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: Node[];
}

function parseXml(xml: string): Node {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const root: Node = { tag: "#root", attrs: {}, text: "", children: [] };
  const stack: Node[] = [root];
  const tagPattern = /<(\/?)([\w-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g;

  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(body))) {
    const [whole, closing, tag, rawAttrs, selfClosing] = match;
    stack[stack.length - 1].text += body.slice(cursor, match.index);
    cursor = match.index + whole.length;

    if (closing) {
      const open = stack.pop();
      assert.ok(open, `unexpected </${tag}>`);
      assert.equal(open.tag, tag, `</${tag}> closes <${open.tag}>`);
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = attr[2];
    }
    const node: Node = { tag, attrs, text: "", children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  assert.equal(stack.length, 1, `unclosed tag <${stack[stack.length - 1].tag}>`);
  return root.children[0];
}

function find(node: Node, tag: string): Node | undefined {
  return node.children.find((c) => c.tag === tag);
}

function findAll(node: Node, tag: string): Node[] {
  return node.children.flatMap((c) => [
    ...(c.tag === tag ? [c] : []),
    ...findAll(c, tag),
  ]);
}

function parseDesktopEntry(content: string): Record<string, string> {
  const entries: Record<string, string> = {};
  let section = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      section = trimmed.slice(1, -1);
      continue;
    }
    if (section !== "Desktop Entry") continue;
    const eq = trimmed.indexOf("=");
    assert.notEqual(eq, -1, `not a key=value line: ${trimmed}`);
    entries[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return entries;
}

/** Width and height straight out of the PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  assert.equal(
    buf.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${path.basename(file)} is not a PNG`,
  );
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("desktop entry", () => {
  const entry = parseDesktopEntry(read(`${APP_ID}.desktop`));

  it("is a launchable application", () => {
    assert.equal(entry.Type, "Application");
    assert.equal(entry.Exec, "audible-backup");
    assert.equal(entry.Terminal, "false");
    assert.ok(entry.Name, "needs a Name");
    assert.ok(entry.Comment, "needs a Comment");
  });

  it("uses the app ID for its icon and window class", () => {
    assert.equal(entry.Icon, APP_ID);
    assert.equal(entry.StartupWMClass, APP_ID);
  });

  it("terminates its multi-value lists, as the spec requires", () => {
    for (const key of ["Categories", "Keywords"]) {
      assert.ok(entry[key], `needs ${key}`);
      assert.ok(entry[key].endsWith(";"), `${key} must end with a semicolon`);
    }
  });
});

describe("AppStream metainfo", () => {
  const component = parseXml(read(`${APP_ID}.metainfo.xml`));

  it("describes a desktop application under the app ID", () => {
    assert.equal(component.tag, "component");
    assert.equal(component.attrs.type, "desktop-application");
    assert.equal(find(component, "id")?.text.trim(), APP_ID);
  });

  it("points at the desktop entry that exists", () => {
    const launchable = find(component, "launchable");
    assert.equal(launchable?.attrs.type, "desktop-id");
    assert.equal(launchable?.text.trim(), `${APP_ID}.desktop`);
    assert.ok(fs.existsSync(path.join(DESKTOP, `${APP_ID}.desktop`)));
  });

  it("carries the fields Flathub requires", () => {
    for (const tag of [
      "name",
      "summary",
      "description",
      "metadata_license",
      "project_license",
      "developer",
      "content_rating",
      "releases",
    ]) {
      assert.ok(find(component, tag), `missing <${tag}>`);
    }
    assert.ok(
      find(component, "url"),
      "missing at least one <url> for the store listing",
    );
  });

  it("declares the same license the repository ships", () => {
    const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    assert.match(license, /^ISC License/);
    assert.equal(find(component, "project_license")?.text.trim(), "ISC");
  });

  it("keeps the summary short enough for a store listing", () => {
    const summary = find(component, "summary")!.text.trim();
    assert.ok(summary.length <= 90, `summary is ${summary.length} chars`);
    assert.ok(!summary.endsWith("."), "summary should not end in a period");
  });

  it("has at least one release with a parseable date", () => {
    const releases = findAll(component, "release");
    assert.ok(releases.length > 0, "needs a <release>");
    for (const release of releases) {
      assert.match(release.attrs.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(release.attrs.version, /^\d+\.\d+\.\d+$/);
    }
  });

  it("references screenshots that are actually in the repository", () => {
    const images = findAll(component, "image").map((i) => i.text.trim());
    assert.ok(images.length > 0, "needs at least one screenshot");

    for (const url of images) {
      assert.ok(
        url.startsWith(RAW_PREFIX),
        `${url} must be served from this repository`,
      );
      const local = path.join(ROOT, url.slice(RAW_PREFIX.length));
      assert.ok(fs.existsSync(local), `${url} has no file at ${local}`);

      // Flathub rejects tiny screenshots and ones wider than 2:1.
      const { width, height } = pngSize(local);
      assert.ok(width >= 624 && height >= 351, `${local} is only ${width}x${height}`);
      assert.ok(width / height <= 2, `${local} is wider than 2:1`);
    }
  });

  it("gives every screenshot a caption", () => {
    for (const shot of findAll(component, "screenshot")) {
      assert.ok(find(shot, "caption")?.text.trim(), "screenshot without caption");
    }
  });
});

describe("icons", () => {
  it("ships a scalable source icon", () => {
    const svg = read("icons", "scalable", `${APP_ID}.svg`);
    assert.match(svg, /<svg[^>]*viewBox="0 0 256 256"/);
  });

  for (const size of [128, 256]) {
    it(`ships a ${size}x${size} PNG matching its directory`, () => {
      const file = path.join(DESKTOP, "icons", `${size}x${size}`, `${APP_ID}.png`);
      assert.deepEqual(pngSize(file), { width: size, height: size });
    });
  }
});

describe("desktop shell", () => {
  const shellPath = path.join(DESKTOP, "audible-backup");
  const shell = fs.readFileSync(shellPath, "utf8");

  it("is an executable gjs module", () => {
    assert.match(shell, /^#!\/usr\/bin\/gjs -m\n/);
    // Without the executable bit the .desktop Exec line silently fails.
    assert.ok(fs.statSync(shellPath).mode & 0o111, "must be executable");
  });

  it("uses the same app ID as the metadata", () => {
    assert.match(shell, new RegExp(`APP_ID = "${APP_ID.replace(/\./g, "\\.")}"`));
  });

  it("waits for the exact line the server prints", () => {
    const server = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
    const prefix = shell.match(/const URL_PREFIX = "([^"]+)"/)?.[1];
    assert.ok(prefix, "shell must declare the URL prefix it waits for");
    assert.ok(
      server.includes(`\`${prefix}\${url}`),
      `server.ts must print ${prefix} for the shell to find`,
    );
  });
});
