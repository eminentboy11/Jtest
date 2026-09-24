const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const JavaScriptObfuscator = require("javascript-obfuscator");

const SOURCE = __dirname;
const OUTPUT = path.join(__dirname, "June x on");
const OUTPUT_RESOLVED = path.resolve(OUTPUT);
const CACHE_FILE = path.join(__dirname, ".obfuscate-cache.json");

// A fixed seed makes the obfuscator deterministic: the same source file
// always produces the exact same obfuscated output. Without this, every
// build re-randomizes string arrays / control flow, so Git sees every
// file as "changed" even when only one file was actually edited.
const OBFUSCATOR_SEED = 1337;

// Anything in this set is skipped entirely, at EVERY directory level
const EXCLUDE_NAMES = new Set([
  ".git",
  ".github",
  "node_modules",
  "June x on",
  "obfuscator.js",
  "package-lock.json",
  ".gitignore",
  ".env",
  "README.md",
  ".obfuscate-cache.json"
]);

// Load previous run's cache: relPath -> { hash, output }
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch (err) {
    console.log(`⚠ Could not parse cache file, starting fresh: ${err.message}`);
    cache = {};
  }
}
const newCache = {};

function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function processDirectory(source, output) {
  // Belt-and-suspenders: never recurse into the output dir itself,
  // no matter how we got here.
  if (path.resolve(source) === OUTPUT_RESOLVED) {
    console.log(`⨯ Refused to walk into output dir: ${source}`);
    return;
  }

  // Read the source listing BEFORE creating the output dir, so a
  // freshly created output folder can never appear in this listing.
  const items = fs.readdirSync(source);
  fs.mkdirSync(output, { recursive: true });

  for (const item of items) {
    // Excluded at every level, not just the root.
    if (EXCLUDE_NAMES.has(item)) {
      console.log(`⨯ Skipped: ${path.relative(SOURCE, path.join(source, item))}`);
      continue;
    }

    const sourcePath = path.join(source, item);
    const outputPath = path.join(output, item);

    // Never walk into the output directory even if reached indirectly.
    if (path.resolve(sourcePath) === OUTPUT_RESOLVED) {
      console.log(`⨯ Skipped (is output dir): ${item}`);
      continue;
    }

    const stat = fs.statSync(sourcePath);

    if (stat.isSymbolicLink()) {
      console.log(`⨯ Skipped symlink: ${item}`);
      continue;
    }

    if (stat.isDirectory()) {
      processDirectory(sourcePath, outputPath);
      continue;
    }

    if (path.extname(item).toLowerCase() === ".js") {
      const code = fs.readFileSync(sourcePath, "utf8");
      const relPath = path.relative(SOURCE, sourcePath);
      const hash = hashContent(code);

      const cached = cache[relPath];
      let obfuscatedCode;

      if (cached && cached.hash === hash) {
        // Source unchanged since last run: reuse previous obfuscated
        // output byte-for-byte instead of re-obfuscating.
        obfuscatedCode = cached.output;
        console.log(`= Unchanged, reused cache: ${relPath}`);
      } else {
        const result = JavaScriptObfuscator.obfuscate(code, {
          compact: true,
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.75,
          numbersToExpressions: true,
          simplify: true,
          stringArray: true,
          stringArrayEncoding: ["base64"],
          rotateStringArray: true,
          unicodeEscapeSequence: false,
          seed: OBFUSCATOR_SEED
        });
        obfuscatedCode = result.getObfuscatedCode();
        console.log(`✓ Obfuscated: ${relPath}`);
      }

      newCache[relPath] = { hash, output: obfuscatedCode };
      fs.writeFileSync(outputPath, obfuscatedCode, "utf8");
    } else {
      fs.copyFileSync(sourcePath, outputPath);
      console.log(`→ Copied: ${path.relative(SOURCE, sourcePath)}`);
    }
  }
}

// Remove previous build
if (fs.existsSync(OUTPUT)) {
  fs.rmSync(OUTPUT, { recursive: true, force: true });
}

processDirectory(SOURCE, OUTPUT);

// Persist the cache for the next run
fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache, null, 2), "utf8");
console.log(`\nCache written: ${Object.keys(newCache).length} JS file(s) tracked.`);
