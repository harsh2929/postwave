// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  SMS_EVIDENCE_READ_RELEASE_HELD_CODE,
  smsEvidenceReleaseHoldCheck,
} from "./sms-evidence-release-hold.mjs";

test("pilot SMS evidence check is a content-light local blocker", () => {
  const privateCampaign = "campaign/+15552345678/private-token";
  const check = smsEvidenceReleaseHoldCheck(privateCampaign);
  const serialized = JSON.stringify(check);

  assert.equal(check.status, "blocker");
  assert.equal(check.evidence.code, SMS_EVIDENCE_READ_RELEASE_HELD_CODE);
  assert.match(check.detail, /made no report request/u);
  assert.doesNotMatch(serialized, /\+15552345678/u);
  assert.doesNotMatch(serialized, /private-token/u);
  assert.doesNotMatch(serialized, /\/api\/v1\//u);
});
