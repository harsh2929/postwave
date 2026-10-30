/**
 * DashboardSectionHeading — a section label with a "see everything" link.
 *
 * The dashboard renders this shape twice ("What's happening → View all",
 * "Recent campaigns → See all") and both copies carried the same nine lines of
 * link typography inline, including the same three-line comment explaining it.
 * Two hand-maintained copies of a style is how the two headings drift apart,
 * and it is also what pushed the screen's single component function over the
 * 300-line budget when its copy moved into the catalogue (DASHBOARD#83).
 *
 * NO COPY LIVES HERE. Every user-facing string arrives as a prop, read from
 * `lib/messagesEn` by the caller, so this component never needs a catalogue
 * entry of its own and cannot become a second place that copy hides.
 *
 * The link is a `TextLink`, so it keeps the 44pt target and the `link`
 * accessibility role; `linkAccessibilityLabel` exists because "View all" on
 * its own tells a screen-reader user nothing about WHAT they would be viewing.
 */
import { SectionLabel } from "@/components/SectionLabel";
import { TextLink } from "@/components/TextLink";
import { FONT } from "@/lib/fonts";
import { useTheme } from "@/lib/theme";
import { typeStyle } from "@/lib/typeScale";

export interface DashboardSectionHeadingProps {
  /** The heading itself, already read from the catalogue. */
  heading: string;
  /** Visible text of the trailing link. */
  linkLabel: string;
  /** What the link actually opens, spoken. Never just the visible label. */
  linkAccessibilityLabel: string;
  onPressLink: () => void;
}

export function DashboardSectionHeading({
  heading,
  linkLabel,
  linkAccessibilityLabel,
  onPressLink,
}: DashboardSectionHeadingProps) {
  const { t } = useTheme();
  return (
    <SectionLabel
      right={
        <TextLink
          onPress={onPressLink}
          accessibilityLabel={linkAccessibilityLabel}
          // `TextLink` already carries the prose ceiling; this only sizes the
          // link to the scale's `label` step instead of a bare literal.
          textStyle={{
            color: t.accent,
            ...typeStyle("label"),
            fontFamily: FONT.semibold,
          }}
        >
          {linkLabel}
        </TextLink>
      }
    >
      {heading}
    </SectionLabel>
  );
}
