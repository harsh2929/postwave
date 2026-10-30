/**
 * Card — the canonical content container in the desktop UI.
 *
 * Three variants:
 *   - "default"  — `.card` styling (bg-elev, border, radius, padding).
 *                  This is what 90% of consumers want — a drop-in
 *                  wrapper around grouped content.
 *   - "elevated" — adds a soft drop-shadow on top of the default. For
 *                  surfaces that need a little extra lift (slideovers,
 *                  modal-adjacent panels, hovering call-outs).
 *   - "subtle"   — no background, just a 1px border + radius. Useful
 *                  for inline groupings (e.g. AIVS bundle download
 *                  block in Compliance) where the page bg should show
 *                  through.
 *
 * The component renders as a plain <div> by default. A section is never
 * meaningful merely because it has a border; callers opt into `as="section"`
 * when the title can label it. `as="li"` supports card-shaped collection
 * records without introducing invalid list markup.
 *
 * Card deliberately has no `onClick` or arbitrary `role` prop. Interactive
 * surfaces place a real button/link inside the Card so keyboard behavior and
 * nested-action ownership stay unambiguous.
 *
 * Padding is controlled separately so a card that wraps a data-table
 * (which brings its own padding) can opt out with padding="none".
 */
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";

import type { PrimitiveLayoutStyle } from "./primitive-style-contract";

export type CardVariant = "default" | "elevated" | "subtle";
export type CardPadding = "none" | "sm" | "md" | "lg";

interface CardBaseProps {
  variant?: CardVariant;
  padding?: CardPadding;
  /** Render an h-stack header row when supplied. */
  title?: ReactNode;
  /** Right-aligned slot in the header row (e.g. menu / action). */
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: PrimitiveLayoutStyle;
  /** Heading level used for the optional title. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
  id?: string;
}

interface CardDataAttributes {
  [name: `data-${string}`]: string | number | boolean | undefined;
}

type CardSectionName =
  | { title: ReactNode; "aria-label"?: string; "aria-labelledby"?: string }
  | { title?: ReactNode; "aria-label": string; "aria-labelledby"?: string }
  | { title?: ReactNode; "aria-label"?: string; "aria-labelledby": string };

export type CardProps = CardBaseProps &
  CardDataAttributes &
  (
    | { /** Neutral container or list record. */ as?: "div" | "li" }
    | ({ /** A section must have an accessible name. */ as: "section" } &
        CardSectionName)
  );

function paddingValue(p: CardPadding): string | number {
  switch (p) {
    case "none":
      return 0;
    case "sm":
      return "var(--pw-sp-2)";
    case "lg":
      return "var(--pw-sp-6)";
    case "md":
    default:
      return "var(--pw-sp-4)";
  }
}

function variantStyle(v: CardVariant): CSSProperties {
  switch (v) {
    case "elevated":
      return {
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md)",
        boxShadow: "var(--pw-elev-2)",
      };
    case "subtle":
      return {
        background: "transparent",
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md)",
      };
    case "default":
    default:
      return {
        background: "var(--pw-bg-elev)",
        border: "1px solid var(--pw-border)",
        borderRadius: "var(--pw-radius-md)",
        boxShadow: "var(--pw-elev-1)",
      };
  }
}

export function Card({
  variant = "default",
  padding = "md",
  as: As = "div",
  title,
  actions,
  children,
  className,
  style,
  headingLevel = 3,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  "data-testid": testId,
  id,
  ...dataAttributes
}: CardProps): ReactElement {
  const generatedTitleId = useId();
  const titleId = title != null ? `${generatedTitleId}-title` : undefined;
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <As
      {...dataAttributes}
      className={["pw-card", className].filter(Boolean).join(" ")}
      data-variant={variant}
      data-testid={testId}
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={
        ariaLabelledBy ?? (As === "section" && !ariaLabel ? titleId : undefined)
      }
      style={{
        ...variantStyle(variant),
        padding: paddingValue(padding),
        ...style,
      }}
    >
      {title != null || actions != null ? (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: title != null ? "space-between" : "flex-end",
            gap: "var(--pw-sp-3)",
            marginBottom: children != null ? "var(--pw-sp-3)" : 0,
          }}
        >
          {title != null ? (
            <Heading
              id={titleId}
              style={{
                margin: 0,
                fontSize: "var(--pw-text-body)",
                fontWeight: 600,
              }}
            >
              {title}
            </Heading>
          ) : null}
          {actions != null ? (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--pw-sp-2)",
              }}
            >
              {actions}
            </div>
          ) : null}
        </header>
      ) : null}
      {children}
    </As>
  );
}
