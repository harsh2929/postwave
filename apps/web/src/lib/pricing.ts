// SPDX-License-Identifier: AGPL-3.0-only
//
// Canonical public catalog. The figures are approved commercial inputs, but
// purchase remains release-held until legal publication and the Dodo monthly
// product rehearsal are complete. Annual prices are planning inputs only.

export type BillingTier = "sandbox" | "launch" | "growth" | "scale";

export interface TierFeature {
  label: string;
  included: boolean;
}

export interface TierDescriptor {
  tier: BillingTier;
  name: string;
  tagline: string;
  price: string;
  annualPrice: string | null;
  cadence: "free" | "monthly";
  perEmail: null;
  features: TierFeature[];
}

export const TIERS: TierDescriptor[] = [
  {
    tier: "sandbox",
    name: "Sandbox",
    tagline: "Explore Moosewave with simulated recipients and events.",
    price: "$0",
    annualPrice: null,
    cadence: "free",
    perEmail: null,
    features: [
      { label: "500 simulated profiles", included: true },
      { label: "1 seat", included: true },
      { label: "Migration dry-runs", included: true },
      { label: "Deterministic fake engagement events", included: true },
      { label: "Production recipients", included: false },
    ],
  },
  {
    tier: "launch",
    name: "Launch",
    tagline: "For a small team building a dependable sending practice.",
    price: "$39",
    annualPrice: "$390",
    cadence: "monthly",
    perEmail: null,
    features: [
      { label: "2,500 active emailable profiles", included: true },
      { label: "25,000 accepted recipients / month", included: true },
      { label: "3 team seats", included: true },
      { label: "5 active automations", included: true },
      { label: "250 AI credits / month", included: true },
      { label: "5 full Inbox Reality reports / month", included: true },
    ],
  },
  {
    tier: "growth",
    name: "Growth",
    tagline: "More volume and operating room for a growing publication.",
    price: "$99",
    annualPrice: "$990",
    cadence: "monthly",
    perEmail: null,
    features: [
      { label: "10,000 active emailable profiles", included: true },
      { label: "100,000 accepted recipients / month", included: true },
      { label: "5 team seats", included: true },
      { label: "25 active automations", included: true },
      { label: "1,250 AI credits / month", included: true },
      { label: "25 full Inbox Reality reports / month", included: true },
    ],
  },
  {
    tier: "scale",
    name: "Scale",
    tagline: "Higher, finite allowances for established email operations.",
    price: "$349",
    annualPrice: "$3,890",
    cadence: "monthly",
    perEmail: null,
    features: [
      { label: "50,000 active emailable profiles", included: true },
      { label: "500,000 accepted recipients / month", included: true },
      { label: "10 team seats", included: true },
      { label: "100 active automations", included: true },
      { label: "5,000 AI credits / month", included: true },
      { label: "100 full Inbox Reality reports / month", included: true },
    ],
  },
];

export interface PlanComparisonRow {
  feature: string;
  values: Record<BillingTier, string | boolean>;
}

export const PLAN_COMPARISON: PlanComparisonRow[] = [
  {
    feature: "Active emailable profiles",
    values: {
      sandbox: "500 simulated",
      launch: "2,500",
      growth: "10,000",
      scale: "50,000",
    },
  },
  {
    feature: "Accepted recipients / month",
    values: {
      sandbox: "0 production",
      launch: "25,000",
      growth: "100,000",
      scale: "500,000",
    },
  },
  {
    feature: "Team seats",
    values: { sandbox: "1", launch: "3", growth: "5", scale: "10" },
  },
  {
    feature: "Active automations",
    values: {
      sandbox: "Simulation",
      launch: "5",
      growth: "25",
      scale: "100",
    },
  },
  {
    feature: "AI credits / month",
    values: {
      sandbox: "Evaluation only",
      launch: "250",
      growth: "1,250",
      scale: "5,000",
    },
  },
  {
    feature: "Rendered previews / month",
    values: {
      sandbox: "Evaluation only",
      launch: "50",
      growth: "250",
      scale: "1,000",
    },
  },
  {
    feature: "Full Inbox Reality reports / month",
    values: { sandbox: "—", launch: "5", growth: "25", scale: "100" },
  },
  {
    feature: "Automatic paid overage",
    values: {
      sandbox: "—",
      launch: "None",
      growth: "None",
      scale: "None",
    },
  },
  {
    feature: "Support response target",
    values: {
      sandbox: "Community",
      launch: "2 business days",
      growth: "1 business day",
      scale: "8 business hours",
    },
  },
];
