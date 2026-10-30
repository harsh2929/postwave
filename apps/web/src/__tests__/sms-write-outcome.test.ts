// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import { smsKnownWriteRefusalMessage } from "@/app/(dashboard)/app/sms/sms-write-outcome";

describe("SMS web write outcome classification", () => {
  it.each([400, 401, 403, 404, 409, 422, 429, 499])(
    "treats typed %i as a known no-commit refusal",
    (status) => {
      expect(
        smsKnownWriteRefusalMessage(
          Object.assign(new Error("unsafe proxy detail"), { status }),
        ),
      ).toMatch(/no change was committed/u);
    },
  );

  it.each([new Error("network"), { status: 500 }, { status: 503 }, null])(
    "keeps transport, 5xx, and untyped receipt failures outcome-unknown",
    (error) => {
      expect(smsKnownWriteRefusalMessage(error)).toBeNull();
    },
  );
});
