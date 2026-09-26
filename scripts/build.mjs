// Builds the single-file game: every src/*.js concatenated into one classic
// <script> (imports/exports stripped), inlined into index.html's markup
// with style.css. Output: dist/interstate-fleet.html (+ dist/bundle.js).
//
//   node scripts/build.mjs
//
// Why a flat bundle: the published Artifact is one self-contained HTML
// file, and every module lands in ONE shared script scope. That has a
// sharp edge the guard below exists for: two files each declaring the
// same top-level `const`/`let`/`class` name is a parse-time SyntaxError
// that kills the entire game silently (this has shipped broken once).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

// Load order matters - several modules read another module's constants
// at load time, not lazily:
//   economy.js before render.js   (render's truckBuckets reads TRUCK_TYPES)
//   geo.js before weather.js      (SNOW_LINE_Y is computed from WORLD_HEIGHT)
//   products.js before economy.js (MILITARY_CITIES / cargo lookups)
//   fleet.js, weather.js before career.js; career.js before wizard-ui.js,
//   career-ui.js; wizard-ui.js before career-ui.js; render.js before
//   director.js (director.js reads render.js's exported constants/
//   functions); director.js before main.js (main.js calls createDirector);
//   main.js last.
// A new src file MUST be added here - the build fails if one is missing.
const ORDER = [
  "data.js", "states-data.js", "geo.js", "flight.js", "driver.js", "products.js", "economy.js",
  "weather.js", "render.js", "fleet.js", "career.js", "wizard-ui.js", "cb.js",
  "camera.js", "ui.js", "career-ui.js", "director.js", "main.js",
];

function fail(msg) {
  console.error("\nBUILD FAILED: " + msg + "\n");
  process.exit(1);
}

const onDisk = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));
const unlisted = onDisk.filter((f) => !ORDER.includes(f));
if (unlisted.length) fail(`src file(s) not in ORDER in scripts/build.mjs: ${unlisted.join(", ")}`);
const missing = ORDER.filter((f) => !onDisk.includes(f));
if (missing.length) fail(`ORDER lists file(s) that don't exist: ${missing.join(", ")}`);

// Pass 1: every exported name per file, so `import * as X from "./y.js"`
// can be rewritten to `const X = { ...y's exports }` (there is no module
// system at runtime to bind a namespace to).
const exportsByFile = new Map();
for (const f of ORDER) {
  const content = fs.readFileSync(path.join(SRC, f), "utf8");
  const names = [];
  const re = /^export\s+(?:async\s+)?(?:function\s*\*?\s*([A-Za-z0-9_$]+)|const\s+([A-Za-z0-9_$]+)|let\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+))/gm;
  let m;
  while ((m = re.exec(content))) names.push(m[1] || m[2] || m[3] || m[4]);
  exportsByFile.set(f, names);
}

const namespaceAliasesEmitted = new Map(); // alias -> target file (first writer wins)

function strip(content, fileName) {
  // Namespace imports -> an object literal of the target's exports. A second
  // file importing the SAME alias from the SAME target just reuses the
  // first declaration (re-emitting it would be a redeclaration).
  content = content.replace(/^import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*["']\.\/([^"']+)["']\s*;?[ \t]*$/gm,
    (whole, alias, targetFile) => {
      const names = exportsByFile.get(targetFile);
      if (!names || !names.length) fail(`namespace import "${alias}" from ./${targetFile} in ${fileName}, but ${targetFile} has no collected exports (is it earlier in ORDER?)`);
      const prior = namespaceAliasesEmitted.get(alias);
      if (prior === targetFile) return "";
      if (prior) fail(`alias "${alias}" already bound to ./${prior}, but ${fileName} imports it from ./${targetFile}`);
      namespaceAliasesEmitted.set(alias, targetFile);
      return `const ${alias} = { ${names.join(", ")} };`;
    });
  // Ordinary relative imports, single- or multi-line.
  content = content.replace(/^import[\s\S]*?from\s*["']\.\/[^"']*["']\s*;?[ \t]*$/gm, "");
  return content.split("\n").map((line) => line.replace(/^export\s+(default\s+)?/, "")).join("\n");
}

const parts = [];
const topLevelDecls = new Map(); // name -> [file, ...] for const/let/class
const topLevelFns = new Map();   // name -> [file, ...] for function
for (const f of ORDER) {
  let content = strip(fs.readFileSync(path.join(SRC, f), "utf8"), f);
  if (f === "ui.js") {
    // ui.js and main.js both declare a top-level `el` / `shieldLabel`.
    content = content.replace(/\bel\b/g, "uiEl").replace(/\bshieldLabel\b/g, "uiShieldLabel");
  }
  // Top-level = column 0 (the codebase indents everything nested).
  for (const m of content.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!topLevelDecls.has(m[1])) topLevelDecls.set(m[1], []);
    topLevelDecls.get(m[1]).push(f);
  }
  for (const m of content.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    if (!topLevelFns.has(m[1])) topLevelFns.set(m[1], []);
    topLevelFns.get(m[1]).push(f);
  }
  parts.push(`// ==== ${f} ====\n${content}`);
}

const declCollisions = [...topLevelDecls].filter(([, files]) => files.length > 1);
if (declCollisions.length) {
  fail("top-level const/let/class declared in more than one file (a SyntaxError that kills the whole bundle):\n  " +
    declCollisions.map(([n, files]) => `${n}: ${files.join(", ")}`).join("\n  ") +
    "\nRename one, or export it from one file and import it in the other.");
}
// A duplicate top-level FUNCTION is legal in a classic script - the later
// one silently replaces the earlier everywhere. Known-harmless pairs are
// allowlisted; anything new is an error.
//   escAttr, renderTabs - identical helpers in both files.
//   statBar - career-ui.js's version replaces ui.js's in the truck detail
//     panel; called with 3 args it emits identical markup (it only adds a
//     0-100% width clamp, and driver stats are always 0-1).
const FN_DUP_ALLOW = new Set(["escAttr", "renderTabs", "statBar"]);
const fnCollisions = [...topLevelFns].filter(([n, files]) => files.length > 1 && !FN_DUP_ALLOW.has(n));
if (fnCollisions.length) {
  fail("top-level function declared in more than one file (the later file's version silently replaces the earlier one everywhere):\n  " +
    fnCollisions.map(([n, files]) => `${n}: ${files.join(", ")}`).join("\n  "));
}

const bundle = parts.join("\n\n");
const leftover = bundle.split("\n").filter((l) => /^\s*(import|export)\b/.test(l));
if (leftover.length) fail("unstripped module statements:\n" + leftover.slice(0, 10).join("\n"));

// Parse check - catches syntax errors here instead of as a blank page.
try { new Function(bundle); } catch (e) { fail("bundle does not parse: " + e.message); }

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "bundle.js"), bundle);

const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const bodyMatch = indexHtml.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) fail("could not find <body> in index.html");
const body = bodyMatch[1].replace(/\s*<script type="module"[^>]*><\/script>\s*/g, "\n");
const fontLink = (indexHtml.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]*>/) || [""])[0];

// meta charset: without it a file:// load decodes as windows-1252 and every
// literal emoji/em-dash in the bundle renders as mojibake in screenshots.
const html = `<meta charset="utf-8">
<title>Interstate Fleet</title>
${fontLink}
<style>
${css}
</style>
${body}
<script>
${bundle}
</script>
`;
const out = path.join(DIST, "interstate-fleet.html");
fs.writeFileSync(out, html);
console.log(`built ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(0)} KB, ${ORDER.length} modules)`);
