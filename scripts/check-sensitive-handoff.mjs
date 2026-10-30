#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";

const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || "git ls-files failed\n");
  process.exit(1);
}

const retiredAccount = ["7008", "4511", "8150"].join("");
const retiredDomain = ["smeltsec", "com"].join(".");
const retiredMailbox = ["harshkumar09104", "gmail.com"].join("@");
const checks = [
  { label: "long-lived AWS access-key identifier", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  { label: "developer-specific macOS home path", pattern: /\/Users\/[A-Za-z0-9._-]+\//u },
  { label: "retired AWS account identifier", literal: retiredAccount },
  { label: "retired MVP domain", literal: retiredDomain },
  { label: "personal MVP mailbox", literal: retiredMailbox },
];

const findings = [];
const files = listed.stdout.split("\0").filter(Boolean);
for (const file of files) {
  let body;
  try {
    body = await readFile(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EISDIR") continue;
    throw error;
  }
  if (body.includes(0)) continue;
  const source = body.toString("utf8");
  for (const check of checks) {
    const matched = check.literal ? source.includes(check.literal) : check.pattern.test(source);
    if (matched) findings.push(`${file}: ${check.label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Sensitive handoff contract failed:\n- ${findings.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Sensitive handoff contract OK: ${files.length} tracked/unignored files contain no governed local, personal, retired-account, or long-lived AWS-key identifiers.\n`,
  );
}
