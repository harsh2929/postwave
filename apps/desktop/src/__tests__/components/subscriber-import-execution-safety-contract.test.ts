import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const wizard = source("../../components/subscribers/ImportSubscribersWizard.tsx");
const steps = source("../../components/subscribers/SubscriberImportSteps.tsx");
const execution = source("../../components/subscribers/useImportExecution.ts");
const importOptions = source("../../components/subscribers/import-options.ts");
const contract = source("../../lib/api/subscriber-import-contract.ts");
const operations = source("../../lib/api/subscriber-data-operations.ts");
const scheduleServer = source("../../../../api/internal/subscriber_import/schedule.go");
const confirmServer = source("../../../../api/internal/subscriber_import/subscriber_import.go");

describe("subscriber import execution truth contract", () => {
  it("exposes one-time immediate execution without recurrence or pacing controls", () => {
    expect(steps).toContain("One-time execution");
    expect(steps).toContain("one-time import");
    expect(wizard).toContain('schedule_type: "immediate"');
    expect(wizard).toContain('schedule_cron: ""');
    expect(wizard).toContain("drip_hours_interval: 0");
    expect(wizard).toContain("drip_hours_total: 0");
    expect(`${wizard}\n${steps}`).not.toMatch(/Daily at|Weekly at|Custom cron|Drip across/);
    expect(importOptions).not.toContain("buildSchedulePatch");
  });

  it("requires a fresh exhaustive dry-run before the only live queue action", () => {
    expect(wizard).toContain("runPreflight");
    expect(wizard).toContain("importPreflightIsFresh");
    expect(wizard).toContain("queueAcknowledged");
    expect(execution).toContain('dry_run: action === "preflight"');
    expect(execution).toContain('settleConfirmation("queue")');
    expect(execution).toContain("confirmFlightRef.current != null");
    expect(operations).toContain("maxAttempts: 1");
  });

  it("pins revision CAS, source fingerprinting, and exact response parsing", () => {
    expect(wizard).toContain("configuration_revision: configurationRevision");
    expect(wizard).toContain("configuration_revision_mismatch");
    expect(contract).toContain("SOURCE_KEY_VERSION_RE");
    expect(contract).toContain("hasExactKeys");
    expect(contract).toContain('source_fingerprint_scheme !== "hmac-sha256-v1"');
    expect(operations).toContain("parseSubscriberImportPatchResponse");
  });

  it("never exposes replace, status, or consent-timestamp import mapping", () => {
    expect(steps).not.toContain('value="replace"');
    expect(steps).not.toContain('kind: "status"');
    expect(steps).not.toContain('kind: "consent_timestamp"');
    expect(steps).toContain("Status and consent timestamps cannot be imported");
    expect(contract).not.toContain('| "replace"');
  });

  it("rejects recurrence/pacing on the server and revalidates at confirmation", () => {
    expect(scheduleServer).toContain("unsupported_recurring_import");
    expect(scheduleServer).toContain("unsupported_import_pacing");
    expect(scheduleServer).toContain("validateConfirmExecution");
    expect(confirmServer).toContain("validateConfirmExecution(sched)");
    expect(confirmServer).toContain("preflight_required");
    expect(confirmServer).toContain("configuration_revision");
  });
});
