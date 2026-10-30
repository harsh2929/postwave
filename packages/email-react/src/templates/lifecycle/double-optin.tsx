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

export interface DoubleOptInProps extends BrandProps {
  /** Confirmation URL containing the opt-in token. */
  confirmUrl: string;
}

/**
 * Double opt-in confirmation. Short copy, single CTA, no marketing.
 * Required for GDPR-compliant lists in DE, FR, IT, and helpful
 * everywhere because confirmed lists deliver better.
 */
export function DoubleOptInTemplate(props: DoubleOptInProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview="Confirm your email" backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Confirm your subscription
          </Heading>
          <Spacer height="8px" />
          <Text>
            Tap the button below to confirm you'd like to receive emails from
            {" "}{b.name}. If you didn't sign up, you can ignore this email
            and nothing more will be sent.
          </Text>
          <Spacer height="24px" />
          <Button href={props.confirmUrl} backgroundColor={b.brandColor}>
            Confirm subscription
          </Button>
          <Spacer height="16px" />
          <Text fontSize="12px" color="#6b7280">
            This link expires in 24 hours.
          </Text>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
