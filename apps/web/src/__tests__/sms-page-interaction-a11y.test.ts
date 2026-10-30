// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  resolve(process.cwd(), "src/app/(dashboard)/app/sms/page.tsx"),
  "utf8",
);
const workspaceSource = readFileSync(
  resolve(process.cwd(), "src/app/(dashboard)/app/sms/sms-workspace.tsx"),
  "utf8",
);
const dialogSource = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/app/sms/sms-quick-reply-dialog.tsx",
  ),
  "utf8",
);

describe("SMS page interaction accessibility ratchets", () => {
  it("uses an accessible controlled editor instead of blocking browser prompts", () => {
    expect(workspaceSource).not.toMatch(/window\.prompt|\bprompt\s*\(/u);
    expect(dialogSource).toContain("<DialogTitle>");
    expect(dialogSource).toContain('htmlFor="sms-template-label"');
    expect(dialogSource).toContain('htmlFor="sms-template-body"');
    expect(dialogSource).toContain('id="sms-template-error"');
  });

  it("guards the displayed query with isError and keeps auth states out of nested mains", () => {
    expect(workspaceSource).toContain("if (!smsDataQuery.isError) return;");
    expect(workspaceSource).not.toContain("<main");
    expect(routeSource).toContain("SMS workspace access could not be verified");
    expect(routeSource).toContain("Owner or admin access required");
  });
});
