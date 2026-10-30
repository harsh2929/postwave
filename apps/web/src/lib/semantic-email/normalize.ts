// SPDX-License-Identifier: AGPL-3.0-only
//
// Mirror of apps/api/internal/semanticemail/normalize.go.
//
// Normalization is what the server PERSISTS and hashes, not what the author
// typed. The editor runs the same pass so what you see previewed is what the
// revision will contain — an editor that previewed the raw input would show
// double spaces and a mixed-case host that the stored document does not have.
//
// Like the Go original this never drops or repairs a semantically invalid
// node. Validity stays an explicit decision made by validate.ts.

import { goFields, goTrimSpace, isGoSpace, isValidUTF8 } from "./go-text";
import { formatGoURL, parseGoURL } from "./go-url";
import {
  LANGUAGE_TAG_SYNTAX,
  LIMITS,
  type Condition,
  type DateTimeContent,
  type InlineRun,
  type MoneyContent,
  type NodeContent,
  type PostalAddress,
  type RichText,
  type SemanticDocument,
  type SemanticNode,
  type SlotReference,
  type StructuredDataContent,
} from "./types";

export function normalizeEnum(input: string): string {
  return goTrimSpace(input).toLowerCase();
}

export function normalizeReference(input: string): string {
  return goTrimSpace(input);
}

/** Collapses every run of Unicode space after NFKC folding. */
export function normalizeNaturalText(input: string): string {
  if (!isValidUTF8(input)) return input;
  return goFields(input.normalize("NFKC")).join(" ");
}

/**
 * Collapses each whitespace run but preserves whether the run began or ended
 * with whitespace, so adjacent semantic spans do not join into one word.
 */
export function normalizeInlineText(input: string): string {
  if (!isValidUTF8(input)) return input;
  const folded = input.normalize("NFKC");
  if (folded === "") return "";
  const characters = [...folded];
  const leading = isGoSpace(characters[0].codePointAt(0) ?? 0);
  const trailing = isGoSpace(
    characters[characters.length - 1].codePointAt(0) ?? 0,
  );
  let middle = goFields(folded).join(" ");
  if (middle === "") return " ";
  if (leading) middle = " " + middle;
  if (trailing) middle += " ";
  return middle;
}

export function normalizeURL(input: string): string {
  const raw = goTrimSpace(input);
  if (raw === "" || new TextEncoder().encode(raw).length > LIMITS.maxURLBytes) {
    return raw;
  }
  const parsed = parseGoURL(raw);
  if (parsed === null || parsed.scheme === "" || parsed.host === "") return raw;
  return formatGoURL(parsed);
}

/**
 * Canonical base-10 decimal without exponent notation. Returns null where Go
 * returns ok=false.
 */
export function normalizeDecimal(input: string): string | null {
  let raw = input;
  if (raw === "") return null;
  let negative = false;
  if (raw[0] === "-") {
    negative = true;
    raw = raw.slice(1);
  }
  if (raw === "" || raw[0] === "+" || (raw.match(/\./g) ?? []).length > 1) {
    return null;
  }
  const dot = raw.indexOf(".");
  const integerPart = dot < 0 ? raw : raw.slice(0, dot);
  const fractionPart = dot < 0 ? null : raw.slice(dot + 1);
  if (integerPart === "" || !/^[0-9]+$/.test(integerPart)) return null;
  let fraction = "";
  if (fractionPart !== null) {
    if (fractionPart === "" || !/^[0-9]+$/.test(fractionPart)) return null;
    fraction = fractionPart.replace(/0+$/, "");
  }
  let integer = integerPart.replace(/^0+/, "");
  if (integer === "") integer = "0";
  let result = integer;
  if (fraction !== "") result += "." + fraction;
  if (negative && result !== "0") result = "-" + result;
  return result;
}

const RFC3339_NANO =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedRFC3339 {
  /** Milliseconds since the epoch of the encoded instant. */
  epochMillis: number;
  /** Encoded zone offset in minutes east of UTC. */
  offsetMinutes: number;
  /** Fractional seconds exactly as written, without the leading dot. */
  fraction: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Mirrors time.Parse(time.RFC3339Nano, value); null where Go errors. */
export function parseRFC3339Nano(value: string): ParsedRFC3339 | null {
  const match = RFC3339_NANO.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }
  // Go truncates a fractional part longer than nine digits.
  const fraction = frac ? frac.slice(1, 10) : "";
  const milliseconds = fraction === "" ? 0 : Number(fraction.slice(0, 3).padEnd(3, "0"));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  return {
    epochMillis: utc - offsetMinutes * 60_000,
    offsetMinutes,
    fraction,
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Mirrors Format(time.RFC3339Nano): trailing zeros dropped, +00:00 as "Z". */
export function formatRFC3339Nano(parsed: ParsedRFC3339): string {
  const pad = (value: number, width = 2) =>
    String(value).padStart(width, "0");
  let out =
    `${pad(parsed.year, 4)}-${pad(parsed.month)}-${pad(parsed.day)}` +
    `T${pad(parsed.hour)}:${pad(parsed.minute)}:${pad(parsed.second)}`;
  const fraction = parsed.fraction.replace(/0+$/, "");
  if (fraction !== "") out += "." + fraction;
  if (parsed.offsetMinutes === 0) return out + "Z";
  const sign = parsed.offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(parsed.offsetMinutes);
  return (
    out + sign + pad(Math.floor(absolute / 60)) + ":" + pad(absolute % 60)
  );
}

export function normalizeDateTime(input: DateTimeContent): DateTimeContent {
  const rfc3339 = goTrimSpace(input.rfc3339);
  const parsed = parseRFC3339Nano(rfc3339);
  return {
    display_value: normalizeNaturalText(input.display_value),
    rfc3339: parsed ? formatRFC3339Nano(parsed) : rfc3339,
    timezone: goTrimSpace(input.timezone),
  };
}

export function normalizeMoney(input: MoneyContent): MoneyContent {
  const trimmed = goTrimSpace(input.amount);
  const canonical = normalizeDecimal(trimmed);
  return {
    display_value: normalizeNaturalText(input.display_value),
    amount: canonical ?? trimmed,
    currency: goTrimSpace(input.currency).toUpperCase(),
  };
}

/**
 * Best-effort BCP 47 canonicalization. x/text's language.Parse is the server's
 * authority and this is Intl's; they agree on the well-formed tags an author
 * types and can disagree on exotic legacy tags, which the server rejects on
 * save with an invalid_language diagnostic rather than storing.
 */
export function normalizeLanguage(input: string): string {
  const raw = goTrimSpace(input);
  if (raw === "" || !LANGUAGE_TAG_SYNTAX.test(raw)) return raw;
  try {
    const canonical = new Intl.Locale(raw).toString();
    return canonical === "" ? raw : canonical;
  } catch {
    return raw;
  }
}

export function normalizeSlot(input: SlotReference): SlotReference {
  return {
    id: normalizeReference(input.id),
    semantic_class: normalizeEnum(input.semantic_class),
    required: input.required,
    fallback: normalizeNaturalText(input.fallback),
  };
}

export function normalizeRichText(input: RichText): RichText {
  return {
    runs: input.runs.map(
      (run): InlineRun => ({
        kind: normalizeEnum(run.kind),
        text: normalizeInlineText(run.text),
        url: normalizeURL(run.url),
        accessible_label: normalizeNaturalText(run.accessible_label),
        slot: run.slot ? normalizeSlot(run.slot) : null,
      }),
    ),
  };
}

function normalizeAddress(input: PostalAddress): PostalAddress {
  return {
    street_address: normalizeNaturalText(input.street_address),
    address_locality: normalizeNaturalText(input.address_locality),
    address_region: normalizeNaturalText(input.address_region),
    postal_code: normalizeNaturalText(input.postal_code),
    address_country: normalizeReference(input.address_country).toUpperCase(),
  };
}

function normalizeStructuredData(
  input: StructuredDataContent,
): StructuredDataContent {
  const out: StructuredDataContent = {
    enabled: input.enabled,
    provider: normalizeEnum(input.provider),
    registry_version: normalizeReference(input.registry_version),
    use_case: normalizeEnum(input.use_case),
    kind: normalizeEnum(input.kind),
    declaration: {},
  };
  const declaration = input.declaration;
  if (declaration.discount_offer) {
    out.declaration.discount_offer = {
      offer_node_id: normalizeReference(declaration.discount_offer.offer_node_id),
    };
  }
  if (declaration.promotion_card) {
    const card = declaration.promotion_card;
    out.declaration.promotion_card = {
      image_node_id: normalizeReference(card.image_node_id),
      action_node_id: normalizeReference(card.action_node_id),
      headline_node_id: normalizeReference(card.headline_node_id),
      price_node_id: normalizeReference(card.price_node_id),
      discount_value_node_id: normalizeReference(card.discount_value_node_id),
      position: card.position,
    };
  }
  if (declaration.event_reservation) {
    const reservation = declaration.event_reservation;
    out.declaration.event_reservation = {
      reservation_number_node_id: normalizeReference(
        reservation.reservation_number_node_id,
      ),
      under_name_node_id: normalizeReference(reservation.under_name_node_id),
      event_name_node_id: normalizeReference(reservation.event_name_node_id),
      start_datetime_node_id: normalizeReference(
        reservation.start_datetime_node_id,
      ),
      location_node_id: normalizeReference(reservation.location_node_id),
      status_node_id: normalizeReference(reservation.status_node_id),
      status: normalizeEnum(reservation.status),
      action_node_id: normalizeReference(reservation.action_node_id),
    };
  }
  if (declaration.order) {
    const order = declaration.order;
    out.declaration.order = {
      merchant_node_id: normalizeReference(order.merchant_node_id),
      order_number_node_id: normalizeReference(order.order_number_node_id),
      total_node_id: normalizeReference(order.total_node_id),
      action_node_id: normalizeReference(order.action_node_id),
      items: order.items.map((item) => ({
        product_node_id: normalizeReference(item.product_node_id),
        price_node_id: normalizeReference(item.price_node_id),
        quantity_node_id: normalizeReference(item.quantity_node_id),
      })),
    };
  }
  return out;
}

export function normalizeContent(input: NodeContent): NodeContent {
  const out: NodeContent = {};
  if (input.heading) {
    out.heading = {
      level: input.heading.level,
      text: normalizeRichText(input.heading.text),
    };
  }
  if (input.paragraph) {
    out.paragraph = { text: normalizeRichText(input.paragraph.text) };
  }
  if (input.list) {
    out.list = {
      ordered: input.list.ordered,
      items: input.list.items.map(normalizeRichText),
    };
  }
  if (input.answer) {
    out.answer = {
      question: normalizeRichText(input.answer.question),
      answer: normalizeRichText(input.answer.answer),
    };
  }
  if (input.legal) {
    out.legal = { text: normalizeRichText(input.legal.text) };
  }
  if (input.action) {
    out.action = {
      action_id: normalizeReference(input.action.action_id),
      label: normalizeNaturalText(input.action.label),
      canonical_url: normalizeURL(input.action.canonical_url),
      accessible_description: normalizeNaturalText(
        input.action.accessible_description,
      ),
    };
  }
  if (input.image) {
    out.image = {
      url: normalizeURL(input.image.url),
      alt: normalizeNaturalText(input.image.alt),
      width: input.image.width,
      height: input.image.height,
    };
  }
  if (input.datetime) out.datetime = normalizeDateTime(input.datetime);
  if (input.money) out.money = normalizeMoney(input.money);
  if (input.deadline) out.deadline = normalizeDateTime(input.deadline);
  if (input.offer) {
    out.offer = {
      description: normalizeRichText(input.offer.description),
      code: normalizeNaturalText(input.offer.code),
      terms: normalizeRichText(input.offer.terms),
      availability_starts: input.offer.availability_starts
        ? normalizeDateTime(input.offer.availability_starts)
        : null,
      availability_ends: input.offer.availability_ends
        ? normalizeDateTime(input.offer.availability_ends)
        : null,
      canonical_offer_id: normalizeReference(
        input.offer.canonical_offer_id,
      ).toLowerCase(),
    };
  }
  if (input.location) {
    out.location = {
      name: normalizeNaturalText(input.location.name),
      address: normalizeAddress(input.location.address),
    };
  }
  if (input.product) {
    out.product = {
      name: normalizeNaturalText(input.product.name),
      sku: normalizeReference(input.product.sku),
      canonical_url: normalizeURL(input.product.canonical_url),
      image_url: normalizeURL(input.product.image_url),
    };
  }
  if (input.fact) {
    out.fact = {
      label: normalizeNaturalText(input.fact.label),
      value: normalizeNaturalText(input.fact.value),
    };
  }
  if (input.personalization) {
    out.personalization = {
      label: normalizeNaturalText(input.personalization.label),
      slot: normalizeSlot(input.personalization.slot),
    };
  }
  if (input.structured_data) {
    out.structured_data = normalizeStructuredData(input.structured_data);
  }
  if (input.divider) out.divider = {};
  if (input.poll) {
    out.poll = {
      poll_id: normalizeReference(input.poll.poll_id),
      question: normalizeRichText(input.poll.question),
      options: input.poll.options.map((option) => ({
        option_id: normalizeReference(option.option_id),
        label: normalizeRichText(option.label),
      })),
    };
  }
  return out;
}

export function normalizeNode(input: SemanticNode): SemanticNode {
  const localizations: Record<string, NodeContent> = {};
  for (const locale of Object.keys(input.localizations).sort()) {
    localizations[normalizeLanguage(locale)] = normalizeContent(
      input.localizations[locale],
    );
  }
  return {
    id: normalizeReference(input.id),
    type: normalizeEnum(input.type),
    role: normalizeEnum(input.role),
    version: input.version,
    content: normalizeContent(input.content),
    conditions: input.conditions.map(
      (condition): Condition => ({
        id: normalizeReference(condition.id),
        slot_id: normalizeReference(condition.slot_id),
        operator: normalizeEnum(condition.operator),
        value: normalizeNaturalText(condition.value),
      }),
    ),
    localizations,
    provenance: {
      source: normalizeEnum(input.provenance.source),
      source_id: normalizeReference(input.provenance.source_id),
    },
  };
}

export function normalizeDocument(input: SemanticDocument): SemanticDocument {
  return {
    schema_version: input.schema_version,
    language: normalizeLanguage(input.language),
    direction: normalizeEnum(input.direction),
    nodes: input.nodes.map(normalizeNode),
  };
}
