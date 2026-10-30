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

export interface PasswordResetProps extends BrandProps {
  resetUrl: string;
  /** Optional inbound IP for the "if this wasn't you" footer. */
  ipAddress?: string;
}

export function PasswordResetTemplate(props: PasswordResetProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview="Reset your password" backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Reset your password
          </Heading>
          <Spacer height="8px" />
          <Text>
            Click the button below to choose a new password. This link
            expires in 60 minutes.
          </Text>
          <Spacer height="24px" />
          <Button href={props.resetUrl} backgroundColor={b.brandColor}>
            Reset password
          </Button>
          <Spacer height="24px" />
          <Text fontSize="12px" color="#6b7280">
            If you didn't request this, you can safely ignore this email — your
            password is unchanged.{" "}
            {props.ipAddress && `Request originated from ${props.ipAddress}.`}
          </Text>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
