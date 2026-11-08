// Fails the release when the packaged folder cannot actually be loaded unpacked.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep, posix } from "node:path";
import process from "node:process";

const stage = process.argv[2];
if (!stage) {
  console.error("usage: verify-package.mjs <staged-extension-dir>");
  process.exit(1);
}

const manifestPath = join(stage, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`manifest.json missing from ${stage}`);
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

// MV3 manifests declare every runtime asset as a path string, so harvesting
// path-shaped strings covers new manifest keys without a hardcoded key list.
function collectPaths(value, out) {
  if (typeof value === "string") {
    if (/\.(js|css|html|png|svg|json)$/.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectPaths(item, out);
  }
  return out;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const files = walk(stage).map((file) => relative(stage, file).split(sep).join("/"));
const fileSet = new Set(files);

function expand(pattern) {
  if (!pattern.includes("*")) return fileSet.has(pattern) ? [pattern] : [];
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const re = new RegExp(`^${source}$`);
  return files.filter((file) => re.test(file));
}

const missing = [];
for (const ref of collectPaths(manifest, [])) {
  if (expand(ref).length === 0) missing.push(ref);
}

if (missing.length > 0) {
  console.error("manifest references files that are not in the package:");
  for (const ref of missing) console.error(`  ${ref}`);
  process.exit(1);
}

// manifest only names entry points; the modules they import are the part that
// silently breaks the extension when packaging drops a directory.
const importPatterns = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

const unresolved = [];
for (const file of files.filter((name) => name.endsWith(".js"))) {
  const source = readFileSync(join(stage, file), "utf8");
  for (const pattern of importPatterns) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!specifier.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!fileSet.has(target)) unresolved.push(`${file} -> ${specifier}`);
    }
  }
}

if (unresolved.length > 0) {
  console.error("modules import files that are not in the package:");
  for (const entry of unresolved) console.error(`  ${entry}`);
  process.exit(1);
}

if (!fileSet.has("LICENSE")) {
  console.error("LICENSE missing from the package");
  process.exit(1);
}

const total = files.reduce((sum, file) => sum + statSync(join(stage, file)).size, 0);
console.log(`${files.length} files, ${(total / 1024).toFixed(1)} KiB:`);
for (const file of files.sort()) {
  console.log(`  ${file}  ${(statSync(join(stage, file)).size / 1024).toFixed(1)} KiB`);
}
