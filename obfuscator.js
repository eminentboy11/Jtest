const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const SOURCE = __dirname;
const OUTPUT = path.join(__dirname, "June x on");

// Anything in this set is skipped entirely (not obfuscated, not copied)
const EXCLUDE = new Set([
  ".git",
  ".github",
  "node_modules",
  "June x on",
  "obfuscator.js",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".env",
  "README.md"
]);

function processDirectory(source, output) {
  fs.mkdirSync(output, { recursive: true });

  for (const item of fs.readdirSync(source)) {
    // Only apply the exclude list at the top level (source === SOURCE),
    // so a subfolder is free to have its own file named e.g. "package.json"
    if (source === SOURCE && EXCLUDE.has(item)) {
      console.log(`⨯ Skipped: ${item}`);
      continue;
    }

    const sourcePath = path.join(source, item);
    const outputPath = path.join(output, item);

    if (fs.statSync(sourcePath).isDirectory()) {
      processDirectory(sourcePath, outputPath);
      continue;
    }

    if (path.extname(item).toLowerCase() === ".js") {
      const code = fs.readFileSync(sourcePath, "utf8");

      const result = JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        numbersToExpressions: true,
        simplify: true,
        stringArray: true,
        stringArrayEncoding: ["base64"],
        rotateStringArray: true,
        unicodeEscapeSequence: false
      });

      fs.writeFileSync(
        outputPath,
        result.getObfuscatedCode(),
        "utf8"
      );

      console.log(`✓ Obfuscated: ${path.relative(SOURCE, sourcePath)}`);
    } else {
      fs.copyFileSync(sourcePath, outputPath);
      console.log(`→ Copied: ${path.relative(SOURCE, sourcePath)}`);
    }
  }
}

// Remove previous build
if (fs.existsSync(OUTPUT)) {
  fs.rmSync(OUTPUT, {
    recursive: true,
    force: true
  });
}

// Build
processDirectory(SOURCE, OUTPUT);
