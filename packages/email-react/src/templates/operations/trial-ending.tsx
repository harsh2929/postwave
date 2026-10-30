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
import { Callout, HeaderBlock, StandardFooter } from "../_shared.js";

export interface TrialEndingProps extends BrandProps {
  firstName?: string;
  /** Number of days remaining (3 or fewer triggers urgency). */
  daysLeft: number;
  upgradeUrl: string;
}

export function TrialEndingTemplate(props: TrialEndingProps): React.ReactElement {
  const b = mergeBrand(props);
  const urgent = props.daysLeft <= 3;
  return (
    <Email preview={`${props.daysLeft} days left on your trial`} backgroundColor="#FDFCF8">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 4px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {urgent
              ? `Only ${props.daysLeft} days left on your trial`
              : `Your trial ends in ${props.daysLeft} days`}
          </Heading>
          <Spacer height="8px" />
          <Text>
            {props.firstName ? `Hi ${props.firstName}, ` : ""}we hope you've
            been getting value from {b.name}. Upgrade to keep your work going.
          </Text>
        </Column>
      </Section>
      {urgent ? (
        <Callout tone="warning">
          <Text color="#92600A" fontWeight="600">
            ⏳ {props.daysLeft} {props.daysLeft === 1 ? "day" : "days"} left —
            your trial ends soon. Upgrade now to keep everything running.
          </Text>
        </Callout>
      ) : null}
      <Section backgroundColor="#ffffff" padding="20px 0 32px 0">
        <Column>
          <Button href={props.upgradeUrl} backgroundColor={b.brandColor}>
            Choose a plan
          </Button>
          <Spacer height="16px" />
          <Text fontSize="14px" color="#6b7280">
            Questions? Reply to this email — we'll get back to you.
          </Text>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
