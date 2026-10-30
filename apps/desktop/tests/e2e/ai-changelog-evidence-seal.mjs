import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const evidenceRoot = path.resolve(
  process.cwd(),
  ".audit-screenshots/ai-changelog-evidence",
);
const manifestName = "SHA256SUMS";
const verificationName = "HASH-VERIFICATION.json";

async function filesBelow(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(absolute) : [absolute];
    }),
  );
  return nested.flat();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

let files = (await filesBelow(evidenceRoot)).filter(
  (file) => path.basename(file) !== manifestName,
);
const verificationPath = path.join(evidenceRoot, verificationName);
const ledgerEntryCount = files.some((file) => file === verificationPath)
  ? files.length
  : files.length + 1;
await fs.writeFile(
  verificationPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sealedAtUtc: "2026-08-09T09:04:30Z",
      algorithm: "SHA-256",
      manifest: manifestName,
      ledgerEntryCount,
      excludedFromManifest: [manifestName],
      verificationCommand: `shasum -a 256 -c ${manifestName}`,
    },
    null,
    2,
  )}\n`,
);

files = (await filesBelow(evidenceRoot))
  .filter((file) => path.basename(file) !== manifestName)
  .sort((left, right) => left.localeCompare(right));
const rows = await Promise.all(
  files.map(async (file) => {
    const relative = path.relative(evidenceRoot, file);
    return `${sha256(await fs.readFile(file))}  ${relative}`;
  }),
);
const manifest = `${rows.join("\n")}\n`;
await fs.writeFile(path.join(evidenceRoot, manifestName), manifest);

for (const row of rows) {
  const [expected, relative] = row.split("  ");
  const actual = sha256(await fs.readFile(path.join(evidenceRoot, relative)));
  if (actual !== expected) throw new Error(`Digest mismatch: ${relative}`);
}

process.stdout.write(
  `${JSON.stringify({
    entries: rows.length,
    manifestSha256: sha256(Buffer.from(manifest)),
    verified: true,
  })}\n`,
);
