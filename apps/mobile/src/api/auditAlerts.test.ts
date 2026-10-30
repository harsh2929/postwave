/**
 * The audit-alert endpoints at the transport boundary — asserted against what
 * `rawRequest` resolves to (the `{data,error}` envelope), because the parser
 * tests cannot see this seam (the audienceDestinations lesson).
 *
 * Contracts under test:
 *  - the pause toggle PATCHes ONLY `{enabled}` and the Slack fan-out ONLY
 *    `{notify_slack}` — each field applies independently server-side, and a
 *    body that rode `channel_config` along would round-trip a credential set
 *    this app deliberately never reads;
 *  - create POSTs the built body verbatim and returns the new id;
 *  - a refused write rejects with its status attached.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_ALERTS_PATH,
  createAuditAlertRule,
  deleteAuditAlertRule,
  fetchAuditAlertRules,
  setAuditAlertEnabled,
  setAuditAlertNotifySlack,
} from "./auditAlerts";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      data: unknown;
      error: { status: number; message: string; code?: string } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      throw Object.assign(new Error(result.error.message), {
        status: result.error.status,
        ...(result.error.code ? { code: result.error.code } : {}),
      });
    }
    return result;
  },
}));

beforeEach(() => rawRequest.mockReset());

describe("rule list transport", () => {
  it("unwraps the {rules} envelope into parsed rules", async () => {
    rawRequest.mockResolvedValue({
      data: {
        rules: [
          {
            id: "r1",
            name: "Exports",
            enabled: true,
            action_glob: "subscribers.export*",
            channel_kind: "email",
          },
        ],
      },
      error: null,
    });
    const rules = await fetchAuditAlertRules();
    expect(rawRequest).toHaveBeenCalledWith("GET", AUDIT_ALERTS_PATH);
    expect(rules.map((r) => r.id)).toEqual(["r1"]);
  });
});

describe("the PATCH writes send one field each", () => {
  it("pause/resume PATCHes only {enabled}", async () => {
    rawRequest.mockResolvedValue({ data: { updated: true }, error: null });
    await setAuditAlertEnabled("r1", false);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      `${AUDIT_ALERTS_PATH}/r1`,
      { enabled: false },
    );
  });

  it("the Slack fan-out PATCHes only {notify_slack}", async () => {
    rawRequest.mockResolvedValue({ data: { updated: true }, error: null });
    await setAuditAlertNotifySlack("r1", true);
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      `${AUDIT_ALERTS_PATH}/r1`,
      { notify_slack: true },
    );
  });
});

describe("create + delete", () => {
  it("POSTs the built body verbatim and returns the new id", async () => {
    rawRequest.mockResolvedValue({ data: { id: "new-rule" }, error: null });
    const body = {
      name: "Exports",
      action_glob: "subscribers.export*",
      operator_kind: "glob",
      channel_kind: "email",
      channel_config: { to: "soc@example.com" },
    };
    await expect(createAuditAlertRule(body)).resolves.toBe("new-rule");
    expect(rawRequest).toHaveBeenCalledWith("POST", AUDIT_ALERTS_PATH, body);
  });

  it("DELETEs the rule id-encoded", async () => {
    rawRequest.mockResolvedValue({ data: { deleted: true }, error: null });
    await deleteAuditAlertRule("a b");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      `${AUDIT_ALERTS_PATH}/a%20b`,
    );
  });

  it("a refused create rejects with the validation status attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 400, code: "invalid_channel", message: "bad channel" },
    });
    await expect(
      createAuditAlertRule({
        name: "x",
        action_glob: "*",
        operator_kind: "glob",
        channel_kind: "email",
        channel_config: {},
      }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_channel" });
  });
});
