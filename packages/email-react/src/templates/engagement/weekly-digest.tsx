// SPDX-License-Identifier: MIT

import * as React from "react";
import { Email } from "../../components/Email.js";
import { Section } from "../../components/Section.js";
import { Column } from "../../components/Column.js";
import { Heading } from "../../components/Heading.js";
import { Text } from "../../components/Text.js";
import { Spacer } from "../../components/Spacer.js";
import type { BrandProps } from "../brand.js";
import { mergeBrand } from "../brand.js";
import { HeaderBlock, StandardFooter } from "../_shared.js";

export interface DigestMetric {
  label: string;
  value: string;
  delta?: string;
}

export interface WeeklyDigestProps extends BrandProps {
  weekOf: string; // "Week of March 18"
  greetingName?: string;
  metrics: DigestMetric[];
  /** Optional editorial commentary. Free-form Markdown not supported here — pass plain text. */
  summary?: string;
}

export function WeeklyDigestTemplate(props: WeeklyDigestProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <Email preview={`Your week at ${b.name}`} backgroundColor="#f8fafc">
      <HeaderBlock {...props} />
      <Section backgroundColor="#ffffff" padding="32px 0 16px 0">
        <Column>
          <Heading level={1} color="#0f172a">
            Your week at {b.name}
          </Heading>
          <Text color="#6b7280" fontSize="14px">
            {props.weekOf}
          </Text>
          {props.greetingName && (
            <>
              <Spacer height="8px" />
              <Text>Hi {props.greetingName} — here's your weekly summary.</Text>
            </>
          )}
        </Column>
      </Section>
      <Section backgroundColor="#ffffff" padding="16px 0 32px 0">
        {props.metrics.map((m, i) => (
          <Column key={i}>
            <Text color="#6b7280" fontSize="12px">
              {m.label}
            </Text>
            <Text fontWeight="700" fontSize="22px" color="#0f172a">
              {m.value}
            </Text>
            {m.delta && (
              <Text color={m.delta.startsWith("+") ? "#16a34a" : "#dc2626"} fontSize="13px">
                {m.delta}
              </Text>
            )}
          </Column>
        ))}
      </Section>
      {props.summary && (
        <Section backgroundColor="#ffffff" padding="0px 0 32px 0">
          <Column>
            <Text>{props.summary}</Text>
          </Column>
        </Section>
      )}
      <StandardFooter {...props} />
    </Email>
  );
}
