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

export interface OrderLineItem {
  name: string;
  qty: number;
  /** Formatted price string ("$24.00"). Pre-formatted so the template stays currency-agnostic. */
  price: string;
}

export interface OrderConfirmationProps extends BrandProps {
  orderNumber: string;
  customerName?: string;
  items: OrderLineItem[];
  subtotal: string;
  shipping: string;
  tax: string;
  total: string;
  orderUrl: string;
}

export function OrderConfirmationTemplate(props: OrderConfirmationProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={`Order ${props.orderNumber} confirmed`} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 16px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Order #{props.orderNumber} confirmed
          </Heading>
          <Spacer height="8px" />
          <Text>
            Thanks{props.customerName ? `, ${props.customerName}` : ""}. We
            got your order and it's already on its way to packing.
          </Text>
          <Spacer height="24px" />
          <Button href={props.orderUrl} backgroundColor={b.brandColor}>
            View order
          </Button>
        </Column>
      </Section>
      <Section backgroundColor="#ffffff" padding="0px 0 32px 0">
        <Column>
          <Divider borderColor="#e5e7eb" />
          {props.items.map((it, i) => (
            <React.Fragment key={i}>
              <Spacer height="12px" />
              <Text>
                {it.qty} × {it.name} — {it.price}
              </Text>
            </React.Fragment>
          ))}
          <Spacer height="16px" />
          <Divider borderColor="#e5e7eb" />
          <Spacer height="12px" />
          <Text>Subtotal: {props.subtotal}</Text>
          <Text>Shipping: {props.shipping}</Text>
          <Text>Tax: {props.tax}</Text>
          <Spacer height="8px" />
          <Text fontWeight="700" fontSize="18px">
            Total: {props.total}
          </Text>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
