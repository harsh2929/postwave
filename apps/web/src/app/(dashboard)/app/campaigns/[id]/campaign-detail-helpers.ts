// SPDX-License-Identifier: AGPL-3.0-only

import type { Campaign } from "@/lib/campaigns-api";
import type { CampaignSection } from "@/lib/mailchimp-compat-api";

export type CampaignBlock = Record<string, unknown>;
export type CampaignVariant = Record<string, unknown>;

export const CAMPAIGN_TYPES: NonNullable<Campaign["campaign_type"]>[] = [
  "regular",
  "plain_text",
  "ab_test",
  "rss",
  "automated",
  "transactional",
];

export const EDITOR_MODES: NonNullable<Campaign["editor_mode"]>[] = [
  "blocks",
  "html",
  "plain_text",
  "mjml",
];

export const BLOCK_TYPES = [
  "heading",
  "text",
  "image",
  "button",
  "product",
  "product_recommendations",
  "discount_code",
  "survey",
  "social_follow",
  "social_share",
  "rss",
  "video",
  "dynamic_content",
  "conditional_content",
  "section",
];

export function blocksOf(campaign: Campaign): CampaignBlock[] {
  return campaign.content_blocks ?? [];
}

export function variantsOf(campaign: Campaign): CampaignVariant[] {
  return campaign.variants ?? [];
}

export function defaultBlock(
  type: string,
  patch: CampaignBlock = {},
): CampaignBlock {
  if (type === "heading") {
    return { type, content: "New headline", ...patch };
  }
  if (type === "image") {
    return { type, url: "", alt_text: "", ...patch };
  }
  if (type === "button") {
    return { type, label: "Read more", url: "", ...patch };
  }
  if (type === "product") {
    return {
      type,
      title: "Featured product",
      url: "",
      image_url: "",
      price: "",
      ...patch,
    };
  }
  if (type === "product_recommendations") {
    return {
      type,
      title: "Recommended for you",
      button_label: "Shop now",
      ...patch,
    };
  }
  if (type === "discount_code") {
    return {
      type,
      code: "SAVE10",
      description: "Use this code at checkout.",
      label: "Redeem offer",
      url: "",
      ...patch,
    };
  }
  if (type === "survey") {
    return {
      type,
      question: "What did you think?",
      choices: "Great, Okay, Not for me",
      url: "",
      ...patch,
    };
  }
  if (type === "social_follow") {
    return {
      type,
      facebook_url: "",
      instagram_url: "",
      linkedin_url: "",
      x_url: "",
      ...patch,
    };
  }
  if (type === "social_share") {
    return {
      type,
      text: "Share this",
      share_url: "",
      ...patch,
    };
  }
  if (type === "rss") {
    return {
      type,
      title: "Latest posts",
      feed_url: "",
      count: "3",
      ...patch,
    };
  }
  if (type === "video") {
    return {
      type,
      video_url: "",
      thumbnail_url: "",
      title: "Watch video",
      label: "Watch now",
      ...patch,
    };
  }
  if (type === "dynamic_content") {
    return {
      type,
      condition: "is_vip",
      content: "VIP offer",
      fallback: "General offer",
      ...patch,
    };
  }
  if (type === "conditional_content") {
    return {
      type,
      condition: "FNAME",
      content: "Hello *|FNAME|*",
      fallback: "Hello",
      ...patch,
    };
  }
  if (type === "section") {
    return { type, section_id: "", name: "", content: "", ...patch };
  }
  return { type: "text", content: "Write your campaign copy.", ...patch };
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asCSV(value: unknown, fallback = ""): string {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)).join(", ");
  }
  return asString(value, fallback);
}

export function isTruthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

export function labelize(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function blockSummary(blocks: CampaignSection["blocks"]): string {
  return blocks
    .map((block) => asString(block.content, asString(block.heading)))
    .filter(Boolean)
    .join("\n");
}
