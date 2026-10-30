import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const iconRoot = path.join(desktopRoot, "src-tauri", "icons");
const manifest = JSON.parse(
  await readFile(path.join(iconRoot, "manifest.json"), "utf8"),
);

const failures = [];
for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
  try {
    const bytes = await readFile(path.join(iconRoot, relative));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      failures.push(`${relative}: sha256 ${actual}, expected ${expected}`);
    }
  } catch (error) {
    failures.push(`${relative}: ${error.message}`);
  }
}
if (failures.length > 0) {
  console.error(`[check-icons] FAIL\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `[check-icons] OK: ${Object.keys(manifest.files).length} release icon artifacts match ${manifest.generator}`,
);
