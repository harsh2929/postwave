/**
 * The SMS inbox told the operator that replies "will appear here".
 *
 * No code path on this server can deliver one. All three inbound SMS webhooks
 * sit behind `smsProviderCallbackReleaseReady`, which is a compile-time
 * `false` in apps/api/internal/sms/handlers.go, and the readiness route says so
 * itself by reporting `sms_provider_callback_release_held` among its blocking
 * reasons. So the empty list was not "nobody has replied yet" — a claim about
 * the operator's own subscribers — it was a switched-off feature wearing the
 * costume of a quiet inbox.
 *
 * That distinction is the whole finding. An operator who believes the first
 * reading concludes their campaign got no responses and changes their
 * messaging; an operator who is told the second reading goes and turns the
 * feature on. This guard keeps the copy on the second reading.
 *
 * WHEN INBOUND OPENS: assertion 1 goes red on purpose, and that red is the
 * to-do — the copy should go back to describing replies once replies can
 * actually arrive. Do not satisfy it by deleting the check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const mobileRoot = fileURLToPath(new URL("../../", import.meta.url));

const goSource = readFileSync(
  `${repoRoot}apps/api/internal/sms/handlers.go`,
  "utf8",
);
const inboxCopy = readFileSync(
  `${mobileRoot}src/components/sms/SmsInboxList.tsx`,
  "utf8",
);

/** Comments describe the hold; only the declaration decides it. */
function releaseFlagIsHeld(): boolean {
  return /^\s*smsProviderCallbackReleaseReady\s*=\s*false\s*$/mu.test(goSource);
}

describe("the SMS inbox does not promise replies the server cannot deliver", () => {
  it("still finds the server-side hold it is reasoning about", () => {
    // If this fails, the flag was renamed or removed — re-read the handler
    // before trusting anything else in this file.
    expect(goSource).toContain("smsProviderCallbackReleaseReady");
    expect(releaseFlagIsHeld()).toBe(true);
  });

  it("does not tell the operator that replies will appear", () => {
    if (!releaseFlagIsHeld()) return;
    // Strip the explanatory comments first: this file documents the very
    // phrase it must not render, and matching that would fail on the comment.
    const rendered = inboxCopy.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, "");
    expect(rendered).not.toMatch(/replies[^"]*will appear/iu);
    expect(rendered).not.toMatch(/Replies to SMS campaigns will appear/iu);
  });

  it("says instead that inbound is not enabled", () => {
    if (!releaseFlagIsHeld()) return;
    expect(inboxCopy).toMatch(/Inbound replies are not enabled/u);
  });
});
