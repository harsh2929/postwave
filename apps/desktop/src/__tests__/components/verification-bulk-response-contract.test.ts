import { describe, expect, it } from "vitest";

import {
  parseEmailHealth,
  parseEmailHealthBatch,
  parseVerificationJobDetail,
  parseVerificationJobs,
  parseVerificationResults,
} from "../../components/deliverability/verification-response-contract";

const RAW_SECRET = "Bearer provider-secret-canary";
const JOB_ID = "71000000-0000-4000-8000-000000000001";

const COMPLETED_JOB = {
  id: JOB_ID,
  status: "completed",
  source: "upload",
  source_ref: RAW_SECRET,
  provider: "zerobounce",
  total: 2,
  processed: 2,
  cache_hits: 1,
  local_filtered: 0,
  vendor_verified: 1,
  credits_spent: 1,
  duplicates: 0,
  created_at: "2026-08-02T09:00:00.000Z",
  started_at: "2026-08-02T09:00:01.000Z",
  completed_at: "2026-08-02T09:00:04.000Z",
};

const PROCESSED_RESULT = {
  email: "private.recipient@example.invalid",
  processed: true,
  status: "valid",
  sub_status: RAW_SECRET,
  score: 9,
  provider: "zerobounce",
  billable: true,
  cached: false,
  did_you_mean: "private.corrected@example.invalid",
  checked_at: "2026-08-02T09:00:03.000Z",
};

const UNPROCESSED_RESULT = {
  email: "waiting.recipient@example.invalid",
  processed: false,
  status: "unknown",
  billable: false,
  cached: false,
};

const HEALTH = {
  email: PROCESSED_RESULT.email,
  grade: "F",
  recommendation: "blocked",
  hard_stop: true,
  send_eligible: false,
  evidence_complete: true,
  reason_codes: ["suppression_hard_bounce"],
  evidence: [
    {
      kind: "hard_stop",
      at: "2026-08-02T08:59:00.000Z",
      source: "send_eligibility",
      reason_code: "suppression_hard_bounce",
    },
  ],
  evidence_at: "2026-08-02T08:59:00.000Z",
  status: "valid",
  score: 9,
  provider: "zerobounce",
  checked_at: "2026-08-02T08:58:00.000Z",
  model_version: "postwave-email-health-v1",
  computed_at: "2026-08-02T09:00:00.000Z",
};

describe("bulk-verification response contracts", () => {
  it("requires the exact jobs envelope and bounds it to the requested first page", () => {
    expect(parseVerificationJobs([COMPLETED_JOB], 50)).toBeNull();
    expect(parseVerificationJobs({}, 50)).toBeNull();
    expect(parseVerificationJobs({ jobs: [COMPLETED_JOB] }, 0)).toBeNull();
    expect(parseVerificationJobs({ jobs: [COMPLETED_JOB] }, 201)).toBeNull();
    expect(
      parseVerificationJobs(
        { jobs: [COMPLETED_JOB, { ...COMPLETED_JOB }] },
        50,
      ),
    ).toBeNull();
    expect(
      parseVerificationJobs({ jobs: [COMPLETED_JOB, COMPLETED_JOB] }, 1),
    ).toBeNull();
    expect(
      parseVerificationJobs(
        {
          jobs: [
            COMPLETED_JOB,
            {
              ...COMPLETED_JOB,
              id: "71000000-0000-4000-8000-000000000002",
              created_at: "2026-08-02T10:00:00.000Z",
              started_at: "2026-08-02T10:00:01.000Z",
              completed_at: "2026-08-02T10:00:04.000Z",
            },
          ],
        },
        50,
      ),
    ).toBeNull();

    const parsed = parseVerificationJobs({ jobs: [COMPLETED_JOB] }, 1);
    expect(parsed).toMatchObject({ limit_reached: true });
    expect(parsed?.rows).toHaveLength(1);
  });

  it("drops source references, provider names, and raw failures before state", () => {
    const failed = {
      ...COMPLETED_JOB,
      status: "failed",
      error: RAW_SECRET,
    };
    const parsed = parseVerificationJobs({ jobs: [failed] }, 50);
    expect(parsed?.rows[0]).toMatchObject({ has_error: true });
    expect(parsed?.rows[0]).not.toHaveProperty("source_ref");
    expect(parsed?.rows[0]).not.toHaveProperty("provider");
    expect(parsed?.rows[0]).not.toHaveProperty("error");
    expect(JSON.stringify(parsed)).not.toContain(RAW_SECRET);
  });

  it("accepts terminal ambiguous work while rejecting impossible accounting", () => {
    const ambiguous = {
      ...COMPLETED_JOB,
      status: "failed",
      total: 3,
      processed: 2,
      ambiguous: 1,
      failure_code: "verification_outcome_ambiguous",
      error: "The verification run failed before it could complete.",
    };
    expect(
      parseVerificationJobs({ jobs: [ambiguous] }, 50)?.rows[0],
    ).toMatchObject({
      ambiguous: 1,
      failure_code: "verification_outcome_ambiguous",
      has_error: true,
    });
    expect(
      parseVerificationJobs({ jobs: [{ ...ambiguous, ambiguous: 2 }] }, 50),
    ).toBeNull();
  });

  it("rejects contradictory job lifecycles and detail accounting", () => {
    expect(
      parseVerificationJobs(
        {
          jobs: [
            {
              ...COMPLETED_JOB,
              status: "pending",
              started_at: "2026-08-02T09:00:01.000Z",
              completed_at: undefined,
            },
          ],
        },
        50,
      ),
    ).toBeNull();
    expect(
      parseVerificationJobs(
        {
          jobs: [
            {
              ...COMPLETED_JOB,
              status: "failed",
              error: undefined,
            },
          ],
        },
        50,
      ),
    ).toBeNull();
    expect(
      parseVerificationJobDetail(
        {
          job: COMPLETED_JOB,
          summary: { valid: 3 },
          credits_saved: 1,
          credits_spent: 1,
          is_terminal: true,
        },
        JOB_ID,
      ),
    ).toBeNull();
    expect(
      parseVerificationJobDetail(
        {
          job: COMPLETED_JOB,
          summary: { valid: 1, invalid: 1 },
          credits_saved: 1,
          credits_spent: 1,
          is_terminal: false,
        },
        JOB_ID,
      ),
    ).toBeNull();
  });

  it("masks recipient evidence, drops provider detail, and uses a sentinel row", () => {
    const parsed = parseVerificationResults(
      {
        results: [
          PROCESSED_RESULT,
          UNPROCESSED_RESULT,
          {
            ...PROCESSED_RESULT,
            email: "third.recipient@example.invalid",
          },
        ],
      },
      5,
      2,
    );

    expect(parsed?.has_more).toBe(true);
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.rows[0]).toMatchObject({
      row_key: "5",
      masked_email: "p••••••••@example.invalid",
      masked_suggestion: "p••••••••@example.invalid",
    });
    expect(parsed?.rows[0]).not.toHaveProperty("email");
    expect(parsed?.rows[0]).not.toHaveProperty("provider");
    expect(parsed?.rows[0]).not.toHaveProperty("sub_status");
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("private.recipient");
    expect(serialized).not.toContain("private.corrected");
    expect(serialized).not.toContain(RAW_SECRET);
  });

  it("validates embedded health and strips its raw address and evidence source", () => {
    expect(parseEmailHealth(HEALTH, PROCESSED_RESULT.email)).toMatchObject({
      grade: "F",
      recommendation: "blocked",
      hard_stop: true,
    });
    const parsed = parseVerificationResults(
      { results: [{ ...PROCESSED_RESULT, health: HEALTH }] },
      0,
      100,
    );
    expect(parsed?.rows[0]?.health).toMatchObject({
      grade: "F",
      recommendation: "blocked",
      evidence_count: 1,
    });
    expect(parsed?.rows[0]?.health).not.toHaveProperty("email");
    expect(parsed?.rows[0]?.health).not.toHaveProperty("evidence");
    expect(JSON.stringify(parsed)).not.toContain("send_eligibility");

    expect(parseEmailHealth({ ...HEALTH, send_eligible: true })).toBeNull();
    expect(parseEmailHealth({ ...HEALTH, recommendation: "send" })).toBeNull();
    expect(parseEmailHealth(HEALTH, "different@example.invalid")).toBeNull();
    expect(
      parseEmailHealth({ ...HEALTH, email: "not-an-email" }, "not-an-email"),
    ).toMatchObject({ grade: "F" });

    const gradeA = {
      ...HEALTH,
      grade: "A",
      recommendation: "send",
      hard_stop: false,
      send_eligible: true,
      reason_codes: ["verification_valid_30d"],
      evidence: [],
      status: "valid",
    };
    expect(parseEmailHealth(gradeA)).toMatchObject({ grade: "A" });
    expect(parseEmailHealth({ ...gradeA, checked_at: undefined })).toBeNull();
    expect(parseEmailHealth({ ...gradeA, status: "unknown" })).toBeNull();
    expect(parseEmailHealth({ ...gradeA, provider: "local" })).toBeNull();
    expect(
      parseEmailHealth({
        ...gradeA,
        computed_at: "2026-02-30T09:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseEmailHealth({
        ...gradeA,
        email: " Private.Recipient@Example.invalid ",
      }),
    ).toBeNull();

    expect(
      parseEmailHealth({
        ...HEALTH,
        grade: "D",
        recommendation: "do_not_send",
        hard_stop: false,
        reason_codes: ["event_bounced_hard"],
        evidence: [
          {
            kind: "hard_bounce",
            at: "2026-08-02T08:59:00.000Z",
            source: "subscriber_events",
            reason_code: "event_bounced_hard",
          },
        ],
      }),
    ).toMatchObject({
      grade: "D",
      recommendation: "do_not_send",
      hard_stop: false,
      send_eligible: false,
    });

    expect(
      parseEmailHealth({
        ...HEALTH,
        grade: "B",
        recommendation: "send",
        hard_stop: false,
        send_eligible: true,
        reason_codes: ["event_delivered"],
        status: "unknown",
        score: undefined,
        provider: undefined,
        checked_at: undefined,
        evidence: [
          {
            kind: "delivered",
            at: "2026-08-02T08:59:00.000Z",
            source: "subscriber_events",
            reason_code: "event_delivered",
          },
        ],
      }),
    ).toMatchObject({
      grade: "B",
      recommendation: "send",
      evidence: [{ kind: "delivered" }],
    });
    expect(
      parseEmailHealth({
        ...HEALTH,
        grade: "B",
        recommendation: "send",
        hard_stop: false,
        send_eligible: true,
        reason_codes: ["vendor_activity"],
        status: undefined,
        score: undefined,
        provider: undefined,
        checked_at: undefined,
        evidence: [
          {
            kind: "vendor_activity",
            at: "2026-08-02T08:59:00.000Z",
            source: "vendor",
            reason_code: "vendor_activity",
          },
        ],
      }),
    ).toBeNull();
  });

  it("accepts only the fail-closed U shape when health evidence is incomplete", () => {
    const incomplete = {
      ...HEALTH,
      grade: "U",
      recommendation: "caution",
      hard_stop: false,
      send_eligible: false,
      evidence_complete: false,
      reason_codes: ["health_evidence_unavailable"],
      evidence: [],
    };
    expect(parseEmailHealth(incomplete)).toMatchObject({
      grade: "U",
      recommendation: "caution",
      send_eligible: false,
      evidence_complete: false,
    });
    expect(parseEmailHealth({ ...incomplete, grade: "A" })).toBeNull();
    expect(parseEmailHealth({ ...incomplete, send_eligible: true })).toBeNull();
  });

  it("requires every grade bucket and reconciles deduplicated health batches", () => {
    const second = {
      ...HEALTH,
      email: "second@example.invalid",
      grade: "A",
      recommendation: "send",
      hard_stop: false,
      send_eligible: true,
      reason_codes: ["verification_valid_30d"],
      evidence: [],
    };
    const batch = {
      results: [HEALTH, second],
      summary: { A: 1, B: 0, C: 0, D: 0, F: 1, U: 0 },
      total: 2,
      duplicates: 1,
      model_version: "postwave-email-health-v1",
    };
    expect(
      parseEmailHealthBatch(batch, [
        PROCESSED_RESULT.email,
        PROCESSED_RESULT.email,
        "second@example.invalid",
      ]),
    ).toMatchObject({ total: 2, duplicates: 1 });
    expect(
      parseEmailHealthBatch(
        { ...batch, summary: { A: 1, B: 0, C: 0, D: 0, F: 1 } },
        [PROCESSED_RESULT.email, "second@example.invalid"],
      ),
    ).toBeNull();
  });

  it("distinguishes an ambiguous provider attempt from an unprocessed row", () => {
    const parsed = parseVerificationResults(
      {
        results: [{ ...UNPROCESSED_RESULT, attempt_state: "ambiguous" }],
      },
      0,
      100,
    );
    expect(parsed?.rows[0]?.attempt_state).toBe("ambiguous");
    expect(
      parseVerificationResults(
        {
          results: [{ ...UNPROCESSED_RESULT, attempt_state: "succeeded" }],
        },
        0,
        100,
      ),
    ).toBeNull();
  });

  it("keeps syntactically invalid job addresses as safely masked result rows", () => {
    const parsed = parseVerificationResults(
      {
        results: [
          {
            ...PROCESSED_RESULT,
            email: "not-an-email",
            status: "invalid",
          },
        ],
      },
      0,
      100,
    );
    expect(parsed?.rows[0]).toMatchObject({
      masked_email: "••••",
      status: "invalid",
    });
  });

  it("requires the results envelope and rejects contradictory result receipts", () => {
    expect(parseVerificationResults([PROCESSED_RESULT], 0, 100)).toBeNull();
    expect(parseVerificationResults({}, 0, 100)).toBeNull();
    expect(
      parseVerificationResults(
        { results: Array.from({ length: 102 }, () => PROCESSED_RESULT) },
        0,
        100,
      ),
    ).toBeNull();
    expect(
      parseVerificationResults(
        { results: [{ ...PROCESSED_RESULT, cached: true }] },
        0,
        100,
      ),
    ).toBeNull();
    expect(
      parseVerificationResults(
        {
          results: [
            {
              ...UNPROCESSED_RESULT,
              checked_at: "2026-08-02T09:00:03.000Z",
            },
          ],
        },
        0,
        100,
      ),
    ).toBeNull();
    expect(
      parseVerificationResults(
        { results: [{ ...PROCESSED_RESULT, checked_at: undefined }] },
        0,
        100,
      ),
    ).toBeNull();
  });
});
