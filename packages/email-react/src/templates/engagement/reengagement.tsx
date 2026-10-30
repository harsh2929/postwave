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

export interface ReengagementProps extends BrandProps {
  firstName?: string;
  /** "We've missed you" vs "Last chance" — controls tone. */
  variant?: "soft" | "direct" | "last_chance";
  ctaUrl: string;
}

export function ReengagementTemplate(props: ReengagementProps): React.ReactElement {
  const b = mergeBrand(props);
  const variant = props.variant ?? "soft";
  const heading =
    variant === "last_chance"
      ? "Last chance — should we keep sending?"
      : variant === "direct"
        ? `Are you still interested in ${b.name}?`
        : `We've missed you at ${b.name}`;
  const body =
    variant === "last_chance"
      ? `It's been a while since we heard from you. If you'd still like to hear from us, click below — otherwise we'll quietly unsubscribe you.`
      : variant === "direct"
        ? `It's been a while. We'd love to know if you still want updates from us, or if you'd rather we stop.`
        : `${props.firstName ? `Hi ${props.firstName}, ` : ""}it's been a while. We'd love to have you back.`;
  return (
    <Email preview={heading} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {heading}
          </Heading>
          <Spacer height="8px" />
          <Text>{body}</Text>
          <Spacer height="24px" />
          <Button href={props.ctaUrl} backgroundColor={b.brandColor}>
            {variant === "last_chance" ? "Keep me subscribed" : "Yes, keep me in"}
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
