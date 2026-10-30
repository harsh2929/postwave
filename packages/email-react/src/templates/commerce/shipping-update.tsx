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

export interface ShippingUpdateProps extends BrandProps {
  orderNumber: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl: string;
  estimatedDelivery?: string;
}

export function ShippingUpdateTemplate(props: ShippingUpdateProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview="Your order is on the way" backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Your order is on the way
          </Heading>
          <Spacer height="8px" />
          <Text>
            Order #{props.orderNumber} just shipped via {props.carrier}.
            {props.estimatedDelivery && ` Estimated delivery: ${props.estimatedDelivery}.`}
          </Text>
          <Spacer height="16px" />
          <Text fontSize="14px" color="#6b7280">
            Tracking number: <strong>{props.trackingNumber}</strong>
          </Text>
          <Spacer height="24px" />
          <Button href={props.trackingUrl} backgroundColor={b.brandColor}>
            Track shipment
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
