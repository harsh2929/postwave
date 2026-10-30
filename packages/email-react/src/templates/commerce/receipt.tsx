// SPDX-License-Identifier: MIT

import * as React from "react";
import { Email } from "../../components/Email.js";
import { Section } from "../../components/Section.js";
import { Column } from "../../components/Column.js";
import { Heading } from "../../components/Heading.js";
import { Text } from "../../components/Text.js";
import { Button } from "../../components/Button.js";
import { Divider } from "../../components/Divider.js";
import { Spacer } from "../../components/Spacer.js";
import type { BrandProps } from "../brand.js";
import { mergeBrand } from "../brand.js";
import { HeaderBlock, StandardFooter } from "../_shared.js";

export interface ReceiptProps extends BrandProps {
  receiptNumber: string;
  paidAt: string; // ISO or formatted date
  customerName?: string;
  description: string; // "Pro plan — annual"
  amount: string;
  /** Last 4 of the card used. */
  cardLast4?: string;
  receiptUrl: string;
}

export function ReceiptTemplate(props: ReceiptProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={`Receipt ${props.receiptNumber}`} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Thank you for your payment
          </Heading>
          <Spacer height="8px" />
          <Text>
            {props.customerName ? `Hi ${props.customerName}, ` : ""}here's your
            receipt for {props.description}.
          </Text>
          <Spacer height="24px" />
          <Divider borderColor="#e5e7eb" />
          <Spacer height="16px" />
          <Text>Receipt #: {props.receiptNumber}</Text>
          <Text>Paid: {props.paidAt}</Text>
          {props.cardLast4 && <Text>Card: •••• {props.cardLast4}</Text>}
          <Spacer height="8px" />
          <Text fontWeight="700" fontSize="18px">
            Amount: {props.amount}
          </Text>
          <Spacer height="24px" />
          <Button href={props.receiptUrl} backgroundColor={b.brandColor}>
            View receipt
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
