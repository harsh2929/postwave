// SPDX-License-Identifier: MIT

import * as React from "react";
import { Email } from "../../components/Email.js";
import { Section } from "../../components/Section.js";
import { Column } from "../../components/Column.js";
import { Heading } from "../../components/Heading.js";
import { Text } from "../../components/Text.js";
import { Button } from "../../components/Button.js";
import { Image } from "../../components/Image.js";
import { Spacer } from "../../components/Spacer.js";
import type { BrandProps } from "../brand.js";
import { mergeBrand } from "../brand.js";
import { HeaderBlock, StandardFooter } from "../_shared.js";

export interface CartItemPreview {
  name: string;
  imageUrl: string;
  price: string;
}

export interface AbandonedCartProps extends BrandProps {
  customerName?: string;
  items: CartItemPreview[];
  cartUrl: string;
  /** Optional discount code (e.g. "WELCOME10") shown beneath the CTA. */
  discountCode?: string;
}

export function AbandonedCartTemplate(props: AbandonedCartProps): React.ReactElement {
  const b = mergeBrand(props);
  const first = props.items[0];
  return (
    <Email preview="Your cart's getting lonely" backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {props.customerName ? `${props.customerName}, you ` : "You "}left
            this behind
          </Heading>
          <Spacer height="8px" />
          <Text>
            Your cart is still saved. Want to pick up where you left off?
          </Text>
          <Spacer height="24px" />
          {first && (
            <>
              <Image src={first.imageUrl} alt={first.name} width="240px" align="center" />
              <Spacer height="8px" />
              <Text align="center" fontWeight="700">
                {first.name}
              </Text>
              <Text align="center" color="#6b7280">
                {first.price}
                {props.items.length > 1 && ` + ${props.items.length - 1} more`}
              </Text>
            </>
          )}
          <Spacer height="24px" />
          <Button href={props.cartUrl} backgroundColor={b.brandColor}>
            Return to cart
          </Button>
          {props.discountCode && (
            <>
              <Spacer height="12px" />
              <Text align="center" fontSize="14px" color="#6b7280">
                Use code <strong>{props.discountCode}</strong> at checkout
              </Text>
            </>
          )}
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
