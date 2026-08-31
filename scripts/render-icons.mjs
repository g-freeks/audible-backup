/**
 * Renders the scalable app icon to the fixed-size PNGs that .desktop files and
 * AppStream consumers expect. Run after editing the SVG:
 *
 *   node scripts/render-icons.mjs
 *
 * Uses the Chromium that already ships for the browser tests, so this needs no
 * extra tooling — but the PNGs are committed, so it is a maintainer step, not
 * part of the build.
 */
import { chromium } from "playwright-core";
import * as fs from "node:fs";
import * as path from "node:path";

const APP_ID = "io.github.g_freeks.audible_backup";
const ROOT = path.resolve(import.meta.dirname, "..");
const SVG = path.join(ROOT, "desktop/icons/scalable", `${APP_ID}.svg`);
const SIZES = [128, 256];

function executable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return fs.existsSync("/opt/pw-browsers/chromium")
    ? "/opt/pw-browsers/chromium"
    : undefined;
}

const svg = fs.readFileSync(SVG, "utf8");
const browser = await chromium.launch({ executablePath: executable() });

for (const size of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  // A transparent page so the icon's own rounded corners stay transparent.
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  const out = path.join(ROOT, "desktop/icons", `${size}x${size}`, `${APP_ID}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log(`wrote ${path.relative(ROOT, out)}`);
}

await browser.close();
