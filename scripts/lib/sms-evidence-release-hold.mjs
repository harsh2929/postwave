// SPDX-License-Identifier: AGPL-3.0-only

export const SMS_EVIDENCE_READ_RELEASE_HELD_CODE =
  "sms_evidence_read_release_held";

export function smsEvidenceReleaseHoldCheck() {
  return {
    name: "sms campaign report",
    status: "blocker",
    detail:
      "Campaign evidence reads are release-held; the pilot smoke made no report request and cannot certify delivery, failures, clicks, or cost.",
    evidence: { code: SMS_EVIDENCE_READ_RELEASE_HELD_CODE },
  };
}
