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

export interface InvoiceProps extends BrandProps {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  customerName?: string;
  amount: string;
  invoiceUrl: string;
}

export function InvoiceTemplate(props: InvoiceProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={`Invoice ${props.invoiceNumber}`} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Invoice #{props.invoiceNumber}
          </Heading>
          <Spacer height="8px" />
          <Text>
            {props.customerName ? `${props.customerName}, ` : ""}your latest
            invoice from {b.name} is ready.
          </Text>
          <Spacer height="24px" />
          <Divider borderColor="#e5e7eb" />
          <Spacer height="16px" />
          <Text>Issued: {props.issueDate}</Text>
          <Text>Due: {props.dueDate}</Text>
          <Spacer height="8px" />
          <Text fontWeight="700" fontSize="20px" color="#0f172a">
            Amount due: {props.amount}
          </Text>
          <Spacer height="24px" />
          <Button href={props.invoiceUrl} backgroundColor={b.brandColor}>
            View invoice
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
