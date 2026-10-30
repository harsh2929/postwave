// SPDX-License-Identifier: MIT
import * as React from "react";
import { Section } from "./Section.js";
import { Column } from "./Column.js";
import { Text } from "./Text.js";
import { Link } from "./Link.js";
import { Divider } from "./Divider.js";

export interface FooterProps {
  /** Sender display name shown in the footer. */
  senderName: string;
  /** Physical mailing address — required by CAN-SPAM. */
  address: string;
  /** Unsubscribe URL. The `{{unsubscribe_url}}` token is also accepted. */
  unsubscribeUrl?: string;
  /** Optional preferences URL. */
  preferencesUrl?: string;
  textColor?: string;
}

/**
 * Common unsubscribe footer. Compiles to a Section + Column with a divider,
 * a small grey body, and the unsubscribe link.
 */
export function Footer(props: FooterProps): React.ReactElement {
  const {
    senderName,
    address,
    unsubscribeUrl = "{{unsubscribe_url}}",
    preferencesUrl,
    textColor = "#6b7280",
  } = props;
  return (
    <Section padding="16px 0">
      <Column>
        <Divider borderColor="#e5e7eb" borderWidth="1px" padding="0 24px 16px 24px" />
        <Text color={textColor} fontSize="12px" align="center" padding="8px 24px">
          You are receiving this because you signed up for {senderName}.
          <br />
          {address}
          <br />
          <Link href={unsubscribeUrl} color={textColor}>
            Unsubscribe
          </Link>
          {preferencesUrl ? (
            <>
              {" · "}
              <Link href={preferencesUrl} color={textColor}>
                Manage preferences
              </Link>
            </>
          ) : null}
        </Text>
      </Column>
    </Section>
  );
}
