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

export interface ProductAnnouncementProps extends BrandProps {
  headline: string;
  subheadline?: string;
  heroImageUrl?: string;
  body: string;
  ctaUrl: string;
  ctaLabel?: string;
}

export function ProductAnnouncementTemplate(props: ProductAnnouncementProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={props.headline} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      {props.heroImageUrl && (
        <Section backgroundColor="#ffffff" padding="0px 0 0px 0">
          <Column>
            <Image src={props.heroImageUrl} alt={props.headline} width="600px" />
          </Column>
        </Section>
      )}
      <Section backgroundColor="#ffffff" padding="32px 0 32px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {props.headline}
          </Heading>
          {props.subheadline && (
            <>
              <Spacer height="4px" />
              <Text color="#6b7280" fontSize="16px">
                {props.subheadline}
              </Text>
            </>
          )}
          <Spacer height="16px" />
          <Text>{props.body}</Text>
          <Spacer height="24px" />
          <Button href={props.ctaUrl} backgroundColor={b.brandColor}>
            {props.ctaLabel ?? "Try it now"}
          </Button>
        </Column>
      </Section>
      <StandardFooter {...props} />
    </Email>
  );
}
