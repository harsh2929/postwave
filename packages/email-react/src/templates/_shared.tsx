// SPDX-License-Identifier: MIT
//
// Shared layout pieces used across templates. Importing these from one
// place keeps the templates short + makes a brand-wide design tweak a
// one-line change in this file.
//
// VOICE (applies to every template's copy): warm, candid, lightly witty —
// like a thoughtful human who respects the reader's time. Lead with the
// point, cut filler, one wink at most. Never scary (a payment failure is
// "no drama," not a threat), never corporate boilerplate. North star:
// welcome.tsx's "a human reads every reply." Test each line: would a founder
// who cares actually write it?

import * as React from "react";
import { Section } from "../components/Section.js";
import { Column } from "../components/Column.js";
import { Image } from "../components/Image.js";
import { Text } from "../components/Text.js";
import { Divider } from "../components/Divider.js";
import { Footer } from "../components/Footer.js";
import { Spacer } from "../components/Spacer.js";
import type { BrandProps } from "./brand.js";
import { mergeBrand } from "./brand.js";

/**
 * Logo + product-name header, present at the top of every template. When no
 * logoUrl is set the name falls back to a wordmark — set in an editorial serif
 * with tightened tracking (echoes the app's Fraunces display voice; email-safe
 * serif stack) in the tenant's brand color, on a warm paper band with a thin
 * hairline below to match the app's paper/line aesthetic.
 */
export function HeaderBlock(props: BrandProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <>
      <Section padding="24px 0 16px 0" backgroundColor="#FDFCF8">
        <Column>
          {b.logoUrl ? (
            <Image src={b.logoUrl} alt={b.name} width="120px" align="center" />
          ) : (
            <Text
              align="center"
              fontSize="22px"
              fontWeight="700"
              color={b.brandColor}
              fontFamily="Georgia, 'Times New Roman', serif"
              letterSpacing="-0.01em"
            >
              {b.name}
            </Text>
          )}
        </Column>
      </Section>
      <Divider
        borderColor="#E0DDD3"
        borderWidth="1px"
        padding="0 24px"
        width="100%"
      />
    </>
  );
}

/**
 * Tone-tinted callout with a 3px left accent — mirrors the app's left-rail
 * blockquote motif so status/urgency content reads as a distinct surface
 * rather than plain body text. Pass Text/Heading as children.
 */
const CALLOUT_TONES = {
  info: { bg: "#EAF1FB", accent: "#2563EB" },
  success: { bg: "#E8F5EE", accent: "#1E9E5A" },
  warning: { bg: "#FEF6E6", accent: "#B7791F" },
  danger: { bg: "#FCE9EC", accent: "#C8102E" },
} as const;

export type CalloutTone = keyof typeof CALLOUT_TONES;

export function Callout({
  tone = "info",
  children,
}: {
  tone?: CalloutTone;
  children: React.ReactNode;
}): React.ReactElement {
  const t = CALLOUT_TONES[tone];
  return (
    <Section
      backgroundColor={t.bg}
      borderLeft={`3px solid ${t.accent}`}
      borderRadius="6px"
      padding="14px 18px"
    >
      <Column>{children}</Column>
    </Section>
  );
}

/** Standard footer with unsubscribe + postal address. */
export function StandardFooter(props: BrandProps): React.ReactElement {
  const b = mergeBrand(props);
  return (
    <>
      <Spacer height="24px" />
      <Footer senderName={b.name} address={b.address} />
    </>
  );
}
