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

export interface WelcomeProps extends BrandProps {
  /** Recipient's first name (or empty for generic salutation). */
  firstName?: string;
  /** Primary CTA URL — typically "complete your profile" or "explore". */
  ctaUrl: string;
  /** CTA label, default "Get started". */
  ctaLabel?: string;
}

/**
 * Welcome — first email after signup. Soft tone, single CTA, no offer.
 */
export function WelcomeTemplate(props: WelcomeProps): React.ReactElement {
  const b = mergeBrand(props);
  const greeting = props.firstName ? `Welcome, ${props.firstName}!` : "Welcome!";
  return (
    <Email preview={`Welcome to ${b.name}`} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {greeting}
          </Heading>
          <Spacer height="8px" />
          <Text>
            Thanks for joining {b.name}. We built this product to help you
            ship work that ships. Take a minute to set things up and we'll
            handle the rest.
          </Text>
          <Spacer height="24px" />
          <Button href={props.ctaUrl} backgroundColor={b.brandColor}>
            {props.ctaLabel ?? "Get started"}
          </Button>
          <Spacer height="16px" />
          <Text fontSize="14px" color="#6b7280">
            Questions? Just reply to this email — a human reads every reply.
          </Text>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
