// SPDX-License-Identifier: MIT

import * as React from "react";
import { Email } from "../../components/Email.js";
import { Section } from "../../components/Section.js";
import { Column } from "../../components/Column.js";
import { Heading } from "../../components/Heading.js";
import { Text } from "../../components/Text.js";
import { Image } from "../../components/Image.js";
import { Link } from "../../components/Link.js";
import { Divider } from "../../components/Divider.js";
import { Spacer } from "../../components/Spacer.js";
import type { BrandProps } from "../brand.js";
import { mergeBrand } from "../brand.js";
import { HeaderBlock, StandardFooter } from "../_shared.js";

export interface NewsletterStory {
  title: string;
  excerpt: string;
  url: string;
  imageUrl?: string;
}

export interface NewsletterProps extends BrandProps {
  issueTitle: string;
  issueNumber?: number;
  stories: NewsletterStory[];
}

export function NewsletterTemplate(props: NewsletterProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={props.issueTitle} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 16px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            {props.issueTitle}
          </Heading>
          {props.issueNumber !== undefined && (
            <Text color="#6b7280" fontSize="14px">
              Issue #{props.issueNumber}
            </Text>
          )}
        </Column>
      </Section>
      {props.stories.map((s, i) => (
        <Section key={i} backgroundColor="#ffffff" padding="16px 0 16px 0">
          <Column>
            {s.imageUrl && (
              <>
                <Image src={s.imageUrl} alt={s.title} width="520px" />
                <Spacer height="12px" />
              </>
            )}
            <Heading level={3} color="#0f172a">
              {s.title}
            </Heading>
            <Spacer height="4px" />
            <Text>{s.excerpt}</Text>
            <Spacer height="8px" />
            <Link href={s.url} color={b.brandColor}>
              Read more →
            </Link>
            {i < props.stories.length - 1 && (
              <>
                <Spacer height="16px" />
                <Divider borderColor="#e5e7eb" />
              </>
            )}
          </Column>
        </Section>
      ))}
      <StandardFooter {...props} />
    </Email>
  );
}
