import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { inventoryIntrinsicTitles } from "./interactive-title-inventory.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const OWNERS = new Set([
  "components/webhook-simulator/SavedPayloadsPanel.tsx",
  "components/webhook-simulator/ResponseInspector.tsx",
  "pages/InboundWebhooks.tsx",
  "pages/OutboundWebhooks.tsx",
  "pages/WebhookSimulator.tsx",
  "pages/WebhooksHome.tsx",
]);

function source(path) {
  return readFileSync(resolve(ROOT, "src", path), "utf8");
}

test("webhook surfaces contain no intrinsic native-title dependency", () => {
  const findings = inventoryIntrinsicTitles(resolve(ROOT, "src")).filter(
    (finding) => OWNERS.has(finding.file),
  );
  assert.deepEqual(findings, []);
});

test("webhook async and destructive flows retain their source-level safety contracts", () => {
  const saved = source("components/webhook-simulator/SavedPayloadsPanel.tsx");
  assert.match(saved, /saveCandidate/);
  assert.match(saved, /saveCommitRef\.current/);
  assert.match(saved, /This change couldn't be saved on this device/);
  assert.match(saved, /Undo delete of/);

  for (const page of [
    "pages/InboundWebhooks.tsx",
    "pages/OutboundWebhooks.tsx",
  ]) {
    const text = source(page);
    assert.match(text, /loadSequenceRef/);
    assert.match(text, /loadFlightRef/);
    assert.match(text, /activeRef\.current/);
    assert.match(text, /aria-disabled/);
    assert.match(text, /role="alert"/);
  }

  const outbound = source("pages/OutboundWebhooks.tsx");
  assert.match(outbound, /typeToConfirm="DELETE"/);
  assert.match(outbound, /remain selected for retry/);
  assert.match(outbound, /Send a test to this production webhook/);
  assert.match(outbound, /credentialBearingURL/);
  assert.match(outbound, /inspectableWebhookURL/);

  const simulator = source("pages/WebhookSimulator.tsx");
  assert.match(simulator, /interface FireSnapshot/);
  assert.match(simulator, /operation\.promiseRef\.current/);
  assert.match(simulator, /useDiscardOnlyDraftLifecycle/);
  assert.match(simulator, /Replace the edited payload/);
  assert.match(simulator, /pendingFireRef\.current/);
  assert.match(simulator, /sanitizeInspectableUrl/);
  assert.match(simulator, /MAX_SIMULATOR_PAYLOAD_CHARACTERS/);

  const inspector = source(
    "components/webhook-simulator/ResponseInspector.tsx",
  );
  assert.match(inspector, /sanitizeInspectableHeaders/);
  assert.match(inspector, /sanitizeInspectableBody/);
  assert.match(inspector, /sanitizeInspectableUrl/);
  assert.match(inspector, /redactCredentialPatterns/);
  assert.match(inspector, /Copy safe curl/);
  assert.doesNotMatch(inspector, /reveal credential/i);
});
