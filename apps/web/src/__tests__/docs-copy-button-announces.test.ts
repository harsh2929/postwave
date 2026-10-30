// SPDX-License-Identifier: AGPL-3.0-only
//
// The docs code-block copy button changes its visible text to "Copied" or
// "Copy failed", and carried a static aria-label="Copy code". aria-label wins
// over content in the accessible-name computation, so a screen-reader user
// heard "Copy code" before the click and "Copy code" after it — identically,
// whether the clipboard write had succeeded or been rejected.
//
// That failure state is reachable, not theoretical: writeText rejects in
// insecure contexts and when the permission is denied. It had already been
// rescued once from a bare `catch { /* noop */ }` so the button would stop
// looking like a mis-click — and was then hidden again from exactly the
// readers who cannot glance at the clipboard to check.
//
// Swept every copy control in the app: the marketing ones carry an aria-live
// region, the dashboard ones raise a toast. This was the only one that
// announced nothing.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { copyButtonLabel } from "@/components/docs/CopyButton";
import { visibleCode } from "./helpers/visible-code";

const SRC = resolve(process.cwd(), "src");
// Comments stripped: the docstring in that file quotes the old
// aria-label="Copy code" while explaining why it was wrong, and the
// assertion below would match the explanation instead of the code.
const SOURCE = visibleCode(
  readFileSync(join(SRC, "components/docs/CopyButton.tsx"), "utf8"),
);

describe("docs copy button accessible name", () => {
  it("says something different for each outcome", () => {
    const names = ["idle", "copied", "error"].map((s) =>
      copyButtonLabel(s as Parameters<typeof copyButtonLabel>[0]),
    );
    expect(new Set(names).size).toBe(3);
  });

  it("tells a failed reader what to do instead", () => {
    // "Copy failed" alone leaves someone who cannot inspect the clipboard with
    // no next step.
    expect(copyButtonLabel("error")).toMatch(/manually/i);
    expect(copyButtonLabel("copied")).toBe("Copied");
  });

  it("is wired to the component's state, not hardcoded", () => {
    expect(SOURCE).toMatch(/aria-label=\{copyButtonLabel\(state\)\}/);
    expect(SOURCE).not.toMatch(/aria-label="Copy code"/);
  });

  it("also carries a live region for a reader who moved on", () => {
    // The label re-announces only while the button holds focus.
    expect(SOURCE).toMatch(/aria-live="polite"/);
    // Rendered from the start, so the region is live before content arrives —
    // a live region inserted at the same time as its text often goes unspoken.
    expect(SOURCE).toMatch(
      /\{copied \|\| failed \? copyButtonLabel\(state\) : ""\}/,
    );
  });
});
