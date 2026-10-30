// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { metadata as acceptInvite } from "@/app/accept-invite/layout";
import { metadata as browserMagic } from "@/app/browser-auth/magic/layout";
import { metadata as browserReset } from "@/app/browser-auth/reset/layout";
import { metadata as cliAuth } from "@/app/cli/auth/layout";
import { metadata as forgotPassword } from "@/app/forgot-password/layout";
import { metadata as login } from "@/app/login/layout";
import { metadata as magicLink } from "@/app/magic-link/layout";
import { metadata as resetPassword } from "@/app/reset-password/layout";
import { metadata as signup } from "@/app/signup/layout";
import { metadata as totp } from "@/app/totp-challenge/layout";
import { metadata as verifyEmail } from "@/app/verify-email/layout";

describe("authentication indexing safety", () => {
  it("gives every credential and account-entry surface a noindex backstop", () => {
    for (const metadata of [
      login,
      signup,
      forgotPassword,
      magicLink,
      resetPassword,
      verifyEmail,
      totp,
      acceptInvite,
      cliAuth,
      browserMagic,
      browserReset,
    ]) {
      expect(metadata.robots).toMatchObject({
        index: false,
        follow: false,
        nocache: true,
      });
    }
  });
});
