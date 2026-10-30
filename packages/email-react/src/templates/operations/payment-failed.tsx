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

export interface PaymentFailedProps extends BrandProps {
  customerName?: string;
  amount: string;
  retryDate: string;
  updatePaymentUrl: string;
  /** Optional reason from the card network (e.g. "insufficient funds"). */
  declineReason?: string;
}

export function PaymentFailedTemplate(props: PaymentFailedProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview="Action required: payment failed" backgroundColor="#FDFCF8">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 4px 0">
        <Column>
          <Heading level={1} color="#dc2626">
            Payment couldn't be processed
          </Heading>
          <Spacer height="8px" />
          <Text>
            {props.customerName ? `${props.customerName}, ` : ""}we tried to
            charge your card {props.amount} for {b.name}, but it was declined
            {props.declineReason ? ` (${props.declineReason})` : ""}.
          </Text>
        </Column>
      </Section>
      <Callout tone="danger">
        <Text color="#7A081B" fontWeight="600">
          We'll automatically retry {props.amount} on {props.retryDate}.
        </Text>
        <Text color="#5C5C5C" fontSize="14px">
          Update your payment method before then to avoid any interruption.
        </Text>
      </Callout>
      <Section backgroundColor="#ffffff" padding="20px 0 32px 0">
        <Column>
          <Button href={props.updatePaymentUrl} backgroundColor={b.brandColor}>
            Update payment method
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
