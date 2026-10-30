import analyticsIllustration from "../assets/illustrations/auth-showcase-analytics.webp";
import audienceIllustration from "../assets/illustrations/auth-showcase-audience.webp";
import campaignsIllustration from "../assets/illustrations/auth-showcase-campaigns.webp";
import deliverabilityIllustration from "../assets/illustrations/auth-showcase-deliverability.webp";
import sequencesIllustration from "../assets/illustrations/auth-showcase-sequences.webp";

export type AuthShowcaseTone = "mint" | "blush" | "blue" | "sand" | "neutral";

export type AuthShowcaseIcon =
  | "campaigns"
  | "audience"
  | "sequences"
  | "deliverability"
  | "analytics";

export interface AuthShowcaseCapability {
  label: string;
  detail: string;
}

export interface AuthShowcaseSlide {
  id: string;
  tone: AuthShowcaseTone;
  icon: AuthShowcaseIcon;
  illustration: string;
  eyebrow: string;
  headline: string;
  sub: string;
  descriptor: string;
  capabilities: readonly AuthShowcaseCapability[];
}

export type AuthShowcaseSlides = readonly [
  AuthShowcaseSlide,
  ...AuthShowcaseSlide[],
];

export const AUTH_SHOWCASE_INTERVAL_MS = 10_000;

export const AUTH_SHOWCASE_SLIDES: AuthShowcaseSlides = [
  {
    id: "campaigns",
    tone: "mint",
    icon: "campaigns",
    illustration: campaignsIllustration,
    eyebrow: "Campaigns",
    headline: "Take every campaign from draft to send.",
    sub: "Draft, test, approve, schedule, and review sent broadcasts in one workspace.",
    descriptor: "Broadcast workflow",
    capabilities: [
      { label: "Draft", detail: "Shape the message" },
      { label: "Test", detail: "Review the result" },
      { label: "Approve", detail: "Confirm readiness" },
      { label: "Schedule", detail: "Choose delivery time" },
    ],
  },
  {
    id: "audience",
    tone: "blue",
    icon: "audience",
    illustration: audienceIllustration,
    eyebrow: "Audience",
    headline: "Turn subscriber data into audiences you can use.",
    sub: "Import, search, inspect, tag, list, and segment subscribers while keeping suppressions in view.",
    descriptor: "Audience toolkit",
    capabilities: [
      { label: "Import", detail: "Bring contacts in" },
      { label: "Search", detail: "Find a person fast" },
      { label: "Tag", detail: "Organize intent" },
      { label: "Segment", detail: "Build reusable groups" },
    ],
  },
  {
    id: "sequences",
    tone: "blush",
    icon: "sequences",
    illustration: sequencesIllustration,
    eyebrow: "Sequences",
    headline: "Build lifecycle journeys around real behavior.",
    sub: "Combine ordered messages, timing, triggers, and branches into reusable sequences.",
    descriptor: "Journey building blocks",
    capabilities: [
      { label: "Trigger", detail: "Start from behavior" },
      { label: "Wait", detail: "Control the timing" },
      { label: "Branch", detail: "Adapt the path" },
      { label: "Message", detail: "Send the next step" },
    ],
  },
  {
    id: "deliverability",
    tone: "neutral",
    icon: "deliverability",
    illustration: deliverabilityIllustration,
    eyebrow: "Deliverability",
    headline: "See the signals that protect every send.",
    sub: "Verify sender DNS, monitor DMARC, review suppressions, and manage delivery controls from one place.",
    descriptor: "Delivery safeguards",
    capabilities: [
      { label: "DNS", detail: "Verify sender setup" },
      { label: "DMARC", detail: "Review reports" },
      { label: "Suppressions", detail: "Respect exclusions" },
      { label: "Controls", detail: "Manage send rules" },
    ],
  },
  {
    id: "analytics",
    tone: "sand",
    icon: "analytics",
    illustration: analyticsIllustration,
    eyebrow: "Analytics",
    headline: "Read delivery and engagement without guesswork.",
    sub: "Compare campaigns and inspect opens, clicks, bounces, replies, and attributed revenue from recorded data.",
    descriptor: "Recorded signals",
    capabilities: [
      { label: "Opens", detail: "Inspect recorded opens" },
      { label: "Clicks", detail: "Follow engagement" },
      { label: "Bounces", detail: "Find delivery issues" },
      { label: "Replies", detail: "See responses" },
    ],
  },
];
