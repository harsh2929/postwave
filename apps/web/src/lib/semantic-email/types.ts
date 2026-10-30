// SPDX-License-Identifier: AGPL-3.0-only
//
// TypeScript mirror of the closed semantic-email v2 node union defined in
// apps/api/internal/semanticemail/types.go.
//
// Two layers, on purpose:
//
//   * The literal unions below (NodeType, NodeRole, InlineKind, …) are the
//     CLOSED vocabulary. Every control in the block editor is populated from
//     these arrays, and role pickers are populated from ROLES_BY_TYPE, so the
//     authoring UI cannot express a combination the server forbids.
//
//   * The decoded document shapes keep `string` for those same fields. That is
//     deliberate and matches Go, where NodeType is a defined string type: a
//     tree that arrived from the API with an unsupported value must be
//     REPRESENTABLE so it can be reported, not silently dropped or "repaired"
//     into something the author never wrote. Validation is what closes the set,
//     exactly as validateNormalizedV2 does.

export const SCHEMA_VERSION_V2 = 2;
export const NODE_VERSION_V2 = 2;

export const NODE_TYPES = [
  "heading",
  "paragraph",
  "list",
  "answer",
  "legal",
  "action",
  "image",
  "datetime",
  "money",
  "deadline",
  "offer",
  "location",
  "product",
  "fact",
  "personalization",
  "structured_data",
  "divider",
  "poll",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_ROLES = [
  "heading",
  "body",
  "answer",
  "legal",
  "footer",
  "primary_action",
  "secondary_action",
  "unsubscribe",
  "preferences",
  "view_in_browser",
  "social",
  "contact",
  "informative_image",
  "decorative_image",
  "event_datetime",
  "price",
  "deadline",
  "offer",
  "location",
  "product",
  "product_fact",
  "personalization_slot",
  "structured_data",
  "divider",
  "poll",
] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

export const DIRECTIONS = ["ltr", "rtl", "auto"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const INLINE_KINDS = [
  "text",
  "strong",
  "emphasis",
  "link",
  "slot",
  "line_break",
] as const;
export type InlineKind = (typeof INLINE_KINDS)[number];

export const SLOT_SEMANTIC_CLASSES = [
  "name",
  "identifier",
  "text",
  "code",
] as const;
export type SlotSemanticClass = (typeof SLOT_SEMANTIC_CLASSES)[number];

export const SOURCE_KINDS = [
  "user",
  "template",
  "generated",
  "migration",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CONDITION_OPERATORS = [
  "present",
  "absent",
  "equals",
  "not_equals",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const RESERVATION_STATUSES = [
  "confirmed",
  "pending",
  "cancelled",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const STRUCTURED_DATA_KINDS = [
  "discount_offer",
  "promotion_card",
  "event_reservation",
  "order",
] as const;
export type StructuredDataKind = (typeof STRUCTURED_DATA_KINDS)[number];

export const STRUCTURED_DATA_USE_CASES = [
  "gmail_promotion",
  "gmail_transaction",
] as const;
export type StructuredDataUseCase = (typeof STRUCTURED_DATA_USE_CASES)[number];

export const GMAIL_REGISTRY_VERSION = "gmail.email-markup.2026-04-20";
export const PROVIDER_GMAIL = "gmail";

/**
 * Which roles each node type accepts — the mirror of rolesByType in
 * validation.go. A role is why a node exists, so the set is genuinely
 * per-type: an image is informative or decorative, an action is a primary CTA
 * or an unsubscribe link, and nothing else is meaningful.
 */
export const ROLES_BY_TYPE: Readonly<Record<NodeType, readonly NodeRole[]>> = {
  heading: ["heading"],
  paragraph: ["body"],
  list: ["body"],
  answer: ["answer"],
  legal: ["legal", "footer"],
  action: [
    "primary_action",
    "secondary_action",
    "unsubscribe",
    "preferences",
    "view_in_browser",
    "social",
    "contact",
  ],
  image: ["informative_image", "decorative_image"],
  datetime: ["event_datetime"],
  money: ["price"],
  deadline: ["deadline"],
  offer: ["offer"],
  location: ["location"],
  product: ["product"],
  fact: ["product_fact"],
  personalization: ["personalization_slot"],
  structured_data: ["structured_data"],
  divider: ["divider"],
  poll: ["poll"],
};

/** Bounds mirrored from validation.go. */
export const LIMITS = {
  maxNodes: 512,
  maxLocalizations: 32,
  maxConditionsPerNode: 32,
  maxRuns: 512,
  maxListItems: 100,
  minPollOptions: 2,
  maxPollOptions: 10,
  maxOrderItems: 100,
  maxTextRunes: 16_384,
  maxShortTextRunes: 512,
  maxURLBytes: 4096,
  maxReferenceBytes: 128,
  maxLanguageTagBytes: 255,
  maxTimezoneBytes: 255,
  maxDecimalDigits: 38,
  maxDecimalScale: 9,
  maxImageDimension: 16_384,
} as const;

export const STABLE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const CANONICAL_OFFER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const LANGUAGE_TAG_SYNTAX = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

// ---------------------------------------------------------------------------
// Decoded document shapes. Field names are the wire names so a decoded
// document IS the payload: there is no second mapping layer to drift.
// ---------------------------------------------------------------------------

export interface SlotReference {
  id: string;
  semantic_class: string;
  required: boolean;
  fallback: string;
}

export interface InlineRun {
  kind: string;
  text: string;
  url: string;
  accessible_label: string;
  slot: SlotReference | null;
}

export interface RichText {
  runs: InlineRun[];
}

export interface HeadingContent {
  level: number;
  text: RichText;
}
export interface ParagraphContent {
  text: RichText;
}
export interface ListContent {
  ordered: boolean;
  items: RichText[];
}
export interface AnswerContent {
  question: RichText;
  answer: RichText;
}
export interface LegalContent {
  text: RichText;
}
export interface ActionContent {
  action_id: string;
  label: string;
  canonical_url: string;
  accessible_description: string;
}
export interface ImageContent {
  url: string;
  alt: string;
  width: number;
  height: number;
}
export interface DateTimeContent {
  display_value: string;
  rfc3339: string;
  timezone: string;
}
export interface MoneyContent {
  display_value: string;
  amount: string;
  currency: string;
}
export interface OfferContent {
  description: RichText;
  code: string;
  terms: RichText;
  availability_starts: DateTimeContent | null;
  availability_ends: DateTimeContent | null;
  /**
   * Names the canonical offer entity this block presents. A reference, never a
   * copy: a semantic tree is shared by every recipient, so an inlined price or
   * window would be one frozen answer handed to everybody and would go stale
   * silently.
   */
  canonical_offer_id: string;
}
export interface PostalAddress {
  street_address: string;
  address_locality: string;
  address_region: string;
  postal_code: string;
  address_country: string;
}
export interface LocationContent {
  name: string;
  address: PostalAddress;
}
export interface ProductContent {
  name: string;
  sku: string;
  canonical_url: string;
  image_url: string;
}
export interface FactContent {
  label: string;
  value: string;
}
export interface PersonalizationContent {
  label: string;
  slot: SlotReference;
}
export type DividerContent = Record<string, never>;

export interface PollOption {
  option_id: string;
  label: RichText;
}
export interface PollContent {
  poll_id: string;
  question: RichText;
  options: PollOption[];
}

export interface DiscountOfferDeclaration {
  offer_node_id: string;
}
export interface PromotionCardDeclaration {
  image_node_id: string;
  action_node_id: string;
  headline_node_id: string;
  price_node_id: string;
  discount_value_node_id: string;
  position: number;
}
export interface EventReservationDeclaration {
  reservation_number_node_id: string;
  under_name_node_id: string;
  event_name_node_id: string;
  start_datetime_node_id: string;
  location_node_id: string;
  status_node_id: string;
  status: string;
  action_node_id: string;
}
export interface OrderItemRef {
  product_node_id: string;
  price_node_id: string;
  quantity_node_id: string;
}
export interface OrderDeclaration {
  merchant_node_id: string;
  order_number_node_id: string;
  total_node_id: string;
  items: OrderItemRef[];
  action_node_id: string;
}
export interface StructuredDeclaration {
  discount_offer?: DiscountOfferDeclaration;
  promotion_card?: PromotionCardDeclaration;
  event_reservation?: EventReservationDeclaration;
  order?: OrderDeclaration;
}
export interface StructuredDataContent {
  enabled: boolean;
  provider: string;
  registry_version: string;
  use_case: string;
  kind: string;
  declaration: StructuredDeclaration;
}

/**
 * Discriminated union carrier. Exactly one member may be present and it must
 * match the node's declared type — the same cardinality rule Go enforces with
 * one non-nil pointer.
 */
export interface NodeContent {
  heading?: HeadingContent;
  paragraph?: ParagraphContent;
  list?: ListContent;
  answer?: AnswerContent;
  legal?: LegalContent;
  action?: ActionContent;
  image?: ImageContent;
  datetime?: DateTimeContent;
  money?: MoneyContent;
  deadline?: DateTimeContent;
  offer?: OfferContent;
  location?: LocationContent;
  product?: ProductContent;
  fact?: FactContent;
  personalization?: PersonalizationContent;
  structured_data?: StructuredDataContent;
  divider?: DividerContent;
  poll?: PollContent;
}

/** The content member each node type owns. */
export const CONTENT_KEY_BY_TYPE: Readonly<
  Record<NodeType, keyof NodeContent>
> = {
  heading: "heading",
  paragraph: "paragraph",
  list: "list",
  answer: "answer",
  legal: "legal",
  action: "action",
  image: "image",
  datetime: "datetime",
  money: "money",
  deadline: "deadline",
  offer: "offer",
  location: "location",
  product: "product",
  fact: "fact",
  personalization: "personalization",
  structured_data: "structured_data",
  divider: "divider",
  poll: "poll",
};

export const CONTENT_KEYS: readonly (keyof NodeContent)[] = [
  "heading",
  "paragraph",
  "list",
  "answer",
  "legal",
  "action",
  "image",
  "datetime",
  "money",
  "deadline",
  "offer",
  "location",
  "product",
  "fact",
  "personalization",
  "structured_data",
  "divider",
  "poll",
];

export interface Condition {
  id: string;
  slot_id: string;
  operator: string;
  value: string;
}

export interface Provenance {
  source: string;
  source_id: string;
}

export interface SemanticNode {
  id: string;
  type: string;
  role: string;
  version: number;
  content: NodeContent;
  conditions: Condition[];
  localizations: Record<string, NodeContent>;
  provenance: Provenance;
}

export interface SemanticDocument {
  schema_version: number;
  language: string;
  direction: string;
  nodes: SemanticNode[];
}

// ---------------------------------------------------------------------------
// Diagnostics — the same stable machine-readable policy the API returns, so an
// inline field error in the editor and a server rejection are the same object.
// Paths are RFC 6901 JSON Pointers; Message is never parsed.
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning";

export type DiagnosticCode =
  | "required"
  | "schema_version_unsupported"
  | "node_version_unsupported"
  | "invalid_enum"
  | "invalid_language"
  | "invalid_stable_reference"
  | "duplicate"
  | "limit_exceeded"
  | "invalid_text"
  | "text_too_long"
  | "content_cardinality"
  | "content_type_mismatch"
  | "role_type_mismatch"
  | "inline_cardinality"
  | "invalid_url"
  | "url_credentials_forbidden"
  | "url_fragment_forbidden"
  | "https_required"
  | "datetime_invalid_rfc3339"
  | "timezone_unknown"
  | "timezone_offset_mismatch"
  | "decimal_invalid"
  | "decimal_precision_exceeded"
  | "number_out_of_range"
  | "currency_invalid_iso4217"
  | "country_invalid_iso3166_1"
  | "image_dimensions_incomplete"
  | "image_alt_required"
  | "decorative_alt_forbidden"
  | "condition_value_forbidden"
  | "condition_value_required"
  | "node_reference_missing"
  | "node_reference_type_mismatch"
  | "structured_kind_mismatch"
  | "registry_version_unsupported"
  | "locale_unavailable"
  | "condition_unresolved"
  | "slot_unresolved"
  | "slot_value_invalid"
  | "structured_source_absent"
  | "structured_data_unverified"
  | "no_visible_content"
  | "multiple_primary_actions"
  | "heading_level_skipped"
  | "multiple_top_level_headings"
  | "canonical_offer_reference_invalid"
  | "invalid_json";

export interface Diagnostic {
  severity: Severity;
  code: DiagnosticCode;
  path: string;
  node_id?: string;
  message: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as readonly string[]).includes(value);
}

export function isNodeRole(value: string): value is NodeRole {
  return (NODE_ROLES as readonly string[]).includes(value);
}

/** RFC 6901 escaping, mirrored from escapeJSONPointer. */
export function escapeJSONPointer(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}
