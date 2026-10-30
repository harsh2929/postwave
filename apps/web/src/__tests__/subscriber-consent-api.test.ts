// SPDX-License-Identifier: AGPL-3.0-only
//
// Transport contracts for the subscriber consent + send-preference module:
// every write is bound to the exact reviewed revision (If-Match), sends the
// server's documented body and nothing else, refuses to run when the client
// could not have reviewed a revision, and verifies the committed response.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});

import {
  channelConsentWriteBlock,
  getGppSections,
  getTrackingConsent,
  jurisdictionCapturedTextError,
  jurisdictionPolicyVersionError,
  readJurisdictionDrift,
  reconfirmJurisdiction,
  regimeForJurisdiction,
  setFrequencyPreference,
  updateTrackingConsent,
} from "@/lib/subscriber-consent-api";
import type { Subscriber } from "@/lib/subscribers-api";

const id = "11111111-1111-4111-8111-111111111111";
const version = `"subscriber:${id}:v4"`;
const freshVersion = `"subscriber:${id}:v5"`;
const trackingVersion = `"subscriber-tracking-consent:${id}:2026-09-01T10:00:00Z"`;
const freshTrackingVersion = `"subscriber-tracking-consent:${id}:2026-09-05T08:00:00Z"`;
const now = "2026-09-05T08:00:00Z";

function emitEtag(options: unknown, etag: string): void {
  const onResponse = (options as { onResponse?: (response: Response) => void })
    ?.onResponse;
  onResponse?.(new Response(null, { headers: { ETag: etag } }));
}

function trackingPrefs(overrides: Record<string, unknown> = {}) {
  return {
    subscriber_id: id,
    subscriber_email: "ada@example.com",
    open_opt_out_at: null,
    click_opt_out_at: null,
    effective_open_opt_out: false,
    effective_click_opt_out: false,
    source: "default",
    gpc: false,
    policy_version: "v1",
    updated_at: now,
    ...overrides,
  };
}

function subscriber(overrides: Partial<Subscriber> = {}): Subscriber {
  return {
    id,
    email: "ada@example.com",
    status: "enabled",
    consent_timestamp: now,
    consent_source: "double_optin",
    custom_fields: {},
    tags: [],
    version,
    ...overrides,
  } as Subscriber;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("tracking consent", () => {
  it("reads the body revision when privacy middleware strips the ETag", async () => {
    mocks.get.mockResolvedValue(trackingPrefs({ version: trackingVersion }));
    expect((await getTrackingConsent(id)).version).toBe(trackingVersion);
  });

  it("verifies the committed body revision after an exact-precondition write", async () => {
    mocks.patch.mockResolvedValue(
      trackingPrefs({
        version: freshTrackingVersion,
        open_opt_out_at: now,
        effective_open_opt_out: true,
      }),
    );
    const result = await updateTrackingConsent(
      id,
      { open_opt_out: true },
      trackingVersion,
    );
    expect(result.version).toBe(freshTrackingVersion);
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/tracking-consent`,
      { open_opt_out: true },
      expect.objectContaining({ headers: { "If-Match": trackingVersion } }),
    );
  });

  it("rejects conflicting body and header revisions", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, trackingVersion);
      return trackingPrefs({ version: freshTrackingVersion });
    });
    await expect(getTrackingConsent(id)).rejects.toThrow(/no exact revision/);
  });

  it("reads the id-keyed route and binds the exact ETag", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, trackingVersion);
      return trackingPrefs();
    });
    const state = await getTrackingConsent(id);
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/tracking-consent`,
      expect.objectContaining({ onResponse: expect.any(Function) }),
    );
    expect(state.version).toBe(trackingVersion);
    expect(state.prefs.effective_open_opt_out).toBe(false);
  });

  it("refuses a read with no exact revision, so the panel cannot write blind", async () => {
    mocks.get.mockResolvedValue(trackingPrefs());
    await expect(getTrackingConsent(id)).rejects.toThrow(/no exact revision/);
  });

  it("refuses a read for a different subscriber", async () => {
    mocks.get.mockImplementation(async (_path, options) => {
      emitEtag(options, trackingVersion);
      return trackingPrefs({ subscriber_id: "someone-else" });
    });
    await expect(getTrackingConsent(id)).rejects.toThrow();
  });

  it("sends one dimension under If-Match and returns the committed state", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshTrackingVersion);
      return trackingPrefs({
        open_opt_out_at: now,
        effective_open_opt_out: true,
        source: "dashboard",
      });
    });
    const state = await updateTrackingConsent(
      id,
      { open_opt_out: true },
      trackingVersion,
      { idempotencyKey: "subscriber-tracking:test-0001" },
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/tracking-consent`,
      { open_opt_out: true },
      expect.objectContaining({
        headers: { "If-Match": trackingVersion },
        idempotencyKey: "subscriber-tracking:test-0001",
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    expect(state.version).toBe(freshTrackingVersion);
    expect(state.prefs.effective_open_opt_out).toBe(true);
  });

  it("refuses to write under a weak, wildcard, or missing revision", async () => {
    for (const bad of ["", "*", 'W/"weak"', "unquoted"]) {
      await expect(
        updateTrackingConsent(id, { click_opt_out: true }, bad),
      ).rejects.toThrow(/Reload these tracking preferences/);
    }
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("refuses an empty decision", async () => {
    await expect(
      updateTrackingConsent(id, {}, trackingVersion),
    ).rejects.toThrow(/Choose the open or click/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("rejects a response that does not carry the decision that was sent", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshTrackingVersion);
      return trackingPrefs(); // open_opt_out_at still null
    });
    await expect(
      updateTrackingConsent(id, { open_opt_out: true }, trackingVersion),
    ).rejects.toThrow(/did not return the committed decision/);
  });
});

describe("send-frequency preference", () => {
  it("patches the subscriber cadence under the reviewed revision", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({
        frequency_preference: "weekly",
        version: freshVersion,
      });
    });
    const updated = await setFrequencyPreference(
      id,
      { frequency_preference: "weekly" },
      version,
      { idempotencyKey: "subscriber-frequency:test-0001" },
    );
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}`,
      { frequency_preference: "weekly" },
      expect.objectContaining({
        headers: { "If-Match": version },
        idempotencyKey: "subscriber-frequency:test-0001",
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    expect(updated.frequency_preference).toBe("weekly");
  });

  it("sends a normalised future pause expiry pinned to the paused cadence", async () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({
        frequency_preference: "paused",
        paused_until: until.toISOString(),
        version: freshVersion,
      });
    });
    await setFrequencyPreference(
      id,
      { frequency_preference: "paused", paused_until: until.toISOString() },
      version,
    );
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({
      frequency_preference: "paused",
      paused_until: until.toISOString(),
    });
  });

  it("sends only clear_paused_until when clearing the expiry", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({ paused_until: null, version: freshVersion });
    });
    await setFrequencyPreference(id, { clear_paused_until: true }, version);
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({
      clear_paused_until: true,
    });
  });

  it("refuses a past expiry and a stale revision before any request", async () => {
    await expect(
      setFrequencyPreference(
        id,
        {
          frequency_preference: "paused",
          paused_until: "2020-01-01T00:00:00Z",
        },
        version,
      ),
    ).rejects.toThrow(/must be in the future/);
    await expect(
      setFrequencyPreference(
        id,
        { frequency_preference: "monthly" },
        '"subscriber:other:v1"',
      ),
    ).rejects.toThrow(/Reload this subscriber/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe("jurisdiction re-confirmation", () => {
  const changedAt = "2026-09-01T10:00:00.123456Z";
  const input = {
    decision: "declined" as const,
    regime: "gdpr" as const,
    privacy_policy_version: "  privacy-2026-09  ",
    captured_text: "  You agree to receive marketing email.\n\tTerms apply.  ",
    expected_jurisdiction_changed_at: changedAt,
    expected_subscriber_version: version,
  };

  it("sends the complete evidence envelope verbatim and binds the returned revision", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({ version: freshVersion });
    });
    const updated = await reconfirmJurisdiction(id, input, {
      idempotencyKey: "subscriber-jurisdiction:test-0001",
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/jurisdiction-reconfirm`,
      {
        decision: "declined",
        regime: "gdpr",
        privacy_policy_version: "privacy-2026-09",
        // The literal disclosure keeps its whitespace: it is legal copy.
        captured_text:
          "  You agree to receive marketing email.\n\tTerms apply.  ",
        expected_jurisdiction_changed_at: changedAt,
        expected_subscriber_version: version,
      },
      expect.objectContaining({
        idempotencyKey: "subscriber-jurisdiction:test-0001",
        maxAttempts: 1,
        requireOnline: true,
      }),
    );
    expect(updated.version).toBe(freshVersion);
  });

  it("rejects a response whose revision does not match its ETag", async () => {
    mocks.patch.mockImplementation(async (_path, _body, options) => {
      emitEtag(options, freshVersion);
      return subscriber({ version });
    });
    await expect(reconfirmJurisdiction(id, input)).rejects.toThrow(
      /did not return the re-confirmed profile revision/,
    );
  });

  it("refuses evidence the server would reject, before any request", async () => {
    await expect(
      reconfirmJurisdiction(id, {
        ...input,
        privacy_policy_version: "privacy​2026",
      }),
    ).rejects.toThrow(/control or invisible/);
    await expect(
      reconfirmJurisdiction(id, { ...input, captured_text: "   " }),
    ).rejects.toThrow(/Paste the exact consent copy/);
    await expect(
      reconfirmJurisdiction(id, {
        ...input,
        expected_subscriber_version: '"subscriber:other:v1"',
      }),
    ).rejects.toThrow(/exact subscriber revision/);
    await expect(
      reconfirmJurisdiction(id, {
        ...input,
        regime: "unknown" as unknown as "gdpr",
      }),
    ).rejects.toThrow(/supported strict consent regime/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("classifies regimes the way the server does", () => {
    expect(regimeForJurisdiction("de")).toBe("gdpr");
    expect(regimeForJurisdiction("GB")).toBe("gdpr");
    expect(regimeForJurisdiction("NO")).toBe("gdpr");
    expect(regimeForJurisdiction("CA")).toBe("casl");
    expect(regimeForJurisdiction("CA", "qc")).toBe("law25");
    expect(regimeForJurisdiction("CA", "Québec")).toBe("law25");
    expect(regimeForJurisdiction("US")).toBe("unknown");
    expect(regimeForJurisdiction(null)).toBe("unknown");
  });

  it("bounds evidence text like normalizeJurisdictionReconfirmInput", () => {
    expect(jurisdictionPolicyVersionError("")).toMatch(/Enter the exact/);
    expect(jurisdictionPolicyVersionError("a".repeat(101))).toMatch(/100/);
    expect(jurisdictionPolicyVersionError("privacy-2026-09")).toBeNull();
    expect(jurisdictionCapturedTextError("line one\n\tline two")).toBeNull();
    expect(jurisdictionCapturedTextError("badbell")).toMatch(/control/);
    expect(jurisdictionCapturedTextError("x".repeat(8193))).toMatch(/8,192/);
  });

  it("reads the drift fields off the record without trusting their shape", () => {
    expect(
      readJurisdictionDrift(
        subscriber({
          jurisdiction_reconfirm_required: true,
          detected_jurisdiction: "DE",
          jurisdiction_changed_at: changedAt,
          region: null,
        } as Partial<Subscriber>),
      ),
    ).toEqual({
      required: true,
      detectedJurisdiction: "DE",
      changedAt,
      region: null,
      version,
    });
    expect(readJurisdictionDrift(undefined).required).toBe(false);
    expect(
      readJurisdictionDrift(
        subscriber({
          jurisdiction_reconfirm_required: true,
          jurisdiction_changed_at: "not a date",
          version: "not-a-version",
        } as Partial<Subscriber>),
      ),
    ).toMatchObject({ required: true, changedAt: null, version: null });
  });
});

describe("GPP sections", () => {
  it("reads the sections and audit trail for exactly this subscriber", async () => {
    mocks.get.mockResolvedValue({
      subscriber_id: id,
      sections: { "us-ca": "DBABLA~BVQqAAAACgA.QA", "eu-tcf": "CP1234" },
      audit: [
        {
          id: "a1",
          subscriber_id: id,
          jurisdiction: "us-ca",
          section_value: "DBABLA~BVQqAAAACgA.QA",
          source: "cmp_webhook",
          created_at: now,
        },
      ],
    });
    const result = await getGppSections(id);
    expect(mocks.get).toHaveBeenCalledWith(
      `/api/v1/subscribers/${id}/gpp`,
      expect.anything(),
    );
    expect(Object.keys(result.sections).sort()).toEqual(["eu-tcf", "us-ca"]);
    expect(result.audit[0]?.source).toBe("cmp_webhook");
  });

  it("refuses sections for a different profile", async () => {
    mocks.get.mockResolvedValue({ subscriber_id: "other", sections: {} });
    await expect(getGppSections(id)).rejects.toThrow(/different profile/);
  });
});

describe("channel consent write gate", () => {
  it("withholds every channel but email with the server's own sentence", () => {
    expect(channelConsentWriteBlock("email")).toBeNull();
    expect(channelConsentWriteBlock("sms")).toBe(
      "sms consent cannot be mutated until its canonical delivery store is connected; frequency-cap-only edits remain available",
    );
  });
});
