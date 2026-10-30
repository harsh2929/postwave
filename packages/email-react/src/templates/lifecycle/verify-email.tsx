// SPDX-License-Identifier: MIT

import * as React from "react";
import { Email } from "../../components/Email.js";
import { Section } from "../../components/Section.js";
import { Column } from "../../components/Column.js";
import { Heading } from "../../components/Heading.js";
import { Text } from "../../components/Text.js";
import { Button } from "../../components/Button.js";
import { Spacer } from "../../components/Spacer.js";
import type { BrandProps } from "../brand.js";
import { mergeBrand } from "../brand.js";
import { HeaderBlock, StandardFooter } from "../_shared.js";

export interface VerifyEmailProps extends BrandProps {
  /** Verification URL. */
  verifyUrl: string;
  /** OTP / 6-digit code (optional, shown alongside the link as fallback). */
  code?: string;
}

/**
 * Account-verification email. The OTP fallback is shown so the user
 * doesn't have to click — useful when they're checking email on
 * another device.
 */
export function VerifyEmailTemplate(props: VerifyEmailProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview="Verify your email" backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Verify your email
          </Heading>
          <Spacer height="8px" />
          <Text>
            One quick tap and you&apos;re in — this is the last hoop, we
            promise.
          </Text>
          <Spacer height="24px" />
          <Button href={props.verifyUrl} backgroundColor={b.brandColor}>
            Verify email
          </Button>
          {props.code && (
            <>
              <Spacer height="24px" />
              <Text fontSize="14px" color="#6b7280">
                Or enter this code on the verification page:
              </Text>
              <Spacer height="4px" />
              <Text fontSize="32px" fontWeight="700" align="center" color="#0f172a">
                {props.code}
              </Text>
            </>
          )}
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
