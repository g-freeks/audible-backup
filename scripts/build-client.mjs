#!/usr/bin/env node
// Builds the React client into src/web/static/app.js + app.css, both
// committed to git — Flathub builds have no network access and skip
// devDependencies when vendoring, so nothing can run this inside the
// Flatpak build itself. See docs/flatpak-plan.md and CLAUDE.md.
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.join(root, "src/web/client/main.tsx");
const jsOut = path.join(root, "src/web/static/app.js");
const cssIn = path.join(root, "src/web/client/theme.css");
const cssOut = path.join(root, "src/web/static/app.css");

const watch = process.argv.includes("--watch");

function copyCss() {
  fs.copyFileSync(cssIn, cssOut);
}

const buildOptions = {
  entryPoints: [entry],
  outfile: jsOut,
  bundle: true,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  copyCss();
  fs.watchFile(cssIn, { interval: 300 }, copyCss);
  console.log("Watching src/web/client/ — Ctrl+C to stop.");
} else {
  await esbuild.build(buildOptions);
  copyCss();
  const jsSize = (fs.statSync(jsOut).size / 1024).toFixed(1);
  const cssSize = (fs.statSync(cssOut).size / 1024).toFixed(1);
  console.log(`Wrote ${jsOut} (${jsSize} KB) and ${cssOut} (${cssSize} KB)`);
}
