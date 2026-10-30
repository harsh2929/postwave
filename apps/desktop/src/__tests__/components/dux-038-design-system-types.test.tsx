import { describe, expect, it } from "vitest";

import type { BannerProps } from "../../components/Banner";
import type { CardProps } from "../../components/Card";
import type { NoticeProps } from "../../components/Notice";

// @ts-expect-error — dismissible banners need a contextual accessible name.
const unnamedDismiss: BannerProps = { onDismiss: () => undefined };

// @ts-expect-error — Card deliberately has no pseudo-button click API.
const clickableCard: CardProps = { onClick: () => undefined };

// @ts-expect-error — a section Card must provide a title or ARIA name.
const unnamedSection: CardProps = { as: "section" };

const semanticNoticeStyle: NoticeProps["style"] = {
  // @ts-expect-error — tone owns semantic paint; callers only get layout.
  background: "red",
};

describe("DUX-038 compile-time primitive guardrails", () => {
  it("keeps the negative type fixtures active", () => {
    expect([
      unnamedDismiss,
      clickableCard,
      unnamedSection,
      semanticNoticeStyle,
    ]).toHaveLength(4);
  });
});
