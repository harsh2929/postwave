import type { Subscriber, SubscriberDetail } from "../lib/api-client";

export type SubscriberMutationHint =
  | { kind: "patch"; delta: Partial<Subscriber> }
  | { kind: "remove" };

export interface SubscriberDetailProps {
  subscriber: Subscriber;
  onClose: () => void;
  onChange?: (
    updated: SubscriberDetail | null,
    hint?: SubscriberMutationHint,
  ) => void;
  navIndex?: number;
  navTotal?: number;
  onNavigate?: (delta: -1 | 1) => void;
}

export type SubscriberDetailTabId =
  | "timeline"
  | "profile"
  | "privacy"
  | "lists"
  | "engagement"
  | "predictive"
  | "referrals"
  | "preferences"
  | "notes"
  | "history"
  | "attributeHistory"
  | "customObjects"
  | "piiFindings"
  | "decisions";
