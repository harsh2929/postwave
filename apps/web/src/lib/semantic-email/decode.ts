// SPDX-License-Identifier: AGPL-3.0-only
//
// Strict decode of the stored semantic node array, mirroring the API's
// authoring boundary (campaignartifact.NormalizeSemanticTreeV2, which decodes
// with DisallowUnknownFields).
//
// The strictness is the point. If the editor quietly ignored a field it did
// not recognise, opening a tree and saving it would DELETE that field —
// silently, with no diagnostic, in a surface whose whole job is to be lossless.
// So an unknown or mistyped field makes the block editor refuse to open the
// document and hand the author back to the JSON editor, which round-trips
// anything.
//
// The document header is not stored with the nodes: content_blocks is a bare
// node array and the API wraps it in {schema_version: 2, language: "en",
// direction: "auto"} at the boundary. The editor validates against the same
// header so an inline diagnostic and a save rejection agree.

import {
  type Condition,
  type DateTimeContent,
  type Diagnostic,
  type InlineRun,
  type NodeContent,
  type OrderItemRef,
  type PollOption,
  type RichText,
  type SemanticDocument,
  type SemanticNode,
  type SlotReference,
  type StructuredDeclaration,
} from "./types";

/** The document context the API wraps a stored node array in. */
export const AUTHORING_DOCUMENT_LANGUAGE = "en";
export const AUTHORING_DOCUMENT_DIRECTION = "auto";

export function documentFromNodes(nodes: SemanticNode[]): SemanticDocument {
  return {
    schema_version: 2,
    language: AUTHORING_DOCUMENT_LANGUAGE,
    direction: AUTHORING_DOCUMENT_DIRECTION,
    nodes,
  };
}

class DecodeError extends Error {}

function fail(path: string, detail: string): never {
  throw new DecodeError(`${path}: ${detail}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function known(
  source: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      fail(path, `unknown field ${JSON.stringify(key)}`);
    }
  }
}

function str(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") fail(`${path}/${key}`, "expected a string");
  return value;
}

function int(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path}/${key}`, "expected an integer");
  }
  return value;
}

function bool(source: Record<string, unknown>, key: string, path: string): boolean {
  const value = source[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") fail(`${path}/${key}`, "expected a boolean");
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(path, "expected an array");
  return value;
}

function decodeSlot(value: unknown, path: string): SlotReference {
  const source = object(value, path);
  known(source, path, ["id", "semantic_class", "required", "fallback"]);
  return {
    id: str(source, "id", path),
    semantic_class: str(source, "semantic_class", path),
    required: bool(source, "required", path),
    fallback: str(source, "fallback", path),
  };
}

function decodeRichText(value: unknown, path: string): RichText {
  if (value === undefined || value === null) return { runs: [] };
  const source = object(value, path);
  known(source, path, ["runs"]);
  return {
    runs: array(source.runs, path + "/runs").map((run, index): InlineRun => {
      const runPath = `${path}/runs/${index}`;
      const entry = object(run, runPath);
      known(entry, runPath, ["kind", "text", "url", "accessible_label", "slot"]);
      return {
        kind: str(entry, "kind", runPath),
        text: str(entry, "text", runPath),
        url: str(entry, "url", runPath),
        accessible_label: str(entry, "accessible_label", runPath),
        slot:
          entry.slot === undefined || entry.slot === null
            ? null
            : decodeSlot(entry.slot, runPath + "/slot"),
      };
    }),
  };
}

function decodeDateTime(value: unknown, path: string): DateTimeContent {
  const source = object(value, path);
  known(source, path, ["display_value", "rfc3339", "timezone"]);
  return {
    display_value: str(source, "display_value", path),
    rfc3339: str(source, "rfc3339", path),
    timezone: str(source, "timezone", path),
  };
}

function decodeDeclaration(value: unknown, path: string): StructuredDeclaration {
  const source = object(value, path);
  known(source, path, [
    "discount_offer",
    "promotion_card",
    "event_reservation",
    "order",
  ]);
  const out: StructuredDeclaration = {};
  if (source.discount_offer !== undefined && source.discount_offer !== null) {
    const inner = object(source.discount_offer, path + "/discount_offer");
    known(inner, path + "/discount_offer", ["offer_node_id"]);
    out.discount_offer = {
      offer_node_id: str(inner, "offer_node_id", path + "/discount_offer"),
    };
  }
  if (source.promotion_card !== undefined && source.promotion_card !== null) {
    const cardPath = path + "/promotion_card";
    const inner = object(source.promotion_card, cardPath);
    known(inner, cardPath, [
      "image_node_id",
      "action_node_id",
      "headline_node_id",
      "price_node_id",
      "discount_value_node_id",
      "position",
    ]);
    out.promotion_card = {
      image_node_id: str(inner, "image_node_id", cardPath),
      action_node_id: str(inner, "action_node_id", cardPath),
      headline_node_id: str(inner, "headline_node_id", cardPath),
      price_node_id: str(inner, "price_node_id", cardPath),
      discount_value_node_id: str(inner, "discount_value_node_id", cardPath),
      position: int(inner, "position", cardPath),
    };
  }
  if (source.event_reservation !== undefined && source.event_reservation !== null) {
    const reservationPath = path + "/event_reservation";
    const inner = object(source.event_reservation, reservationPath);
    known(inner, reservationPath, [
      "reservation_number_node_id",
      "under_name_node_id",
      "event_name_node_id",
      "start_datetime_node_id",
      "location_node_id",
      "status_node_id",
      "status",
      "action_node_id",
    ]);
    out.event_reservation = {
      reservation_number_node_id: str(
        inner,
        "reservation_number_node_id",
        reservationPath,
      ),
      under_name_node_id: str(inner, "under_name_node_id", reservationPath),
      event_name_node_id: str(inner, "event_name_node_id", reservationPath),
      start_datetime_node_id: str(inner, "start_datetime_node_id", reservationPath),
      location_node_id: str(inner, "location_node_id", reservationPath),
      status_node_id: str(inner, "status_node_id", reservationPath),
      status: str(inner, "status", reservationPath),
      action_node_id: str(inner, "action_node_id", reservationPath),
    };
  }
  if (source.order !== undefined && source.order !== null) {
    const orderPath = path + "/order";
    const inner = object(source.order, orderPath);
    known(inner, orderPath, [
      "merchant_node_id",
      "order_number_node_id",
      "total_node_id",
      "items",
      "action_node_id",
    ]);
    out.order = {
      merchant_node_id: str(inner, "merchant_node_id", orderPath),
      order_number_node_id: str(inner, "order_number_node_id", orderPath),
      total_node_id: str(inner, "total_node_id", orderPath),
      action_node_id: str(inner, "action_node_id", orderPath),
      items: array(inner.items, orderPath + "/items").map(
        (item, index): OrderItemRef => {
          const itemPath = `${orderPath}/items/${index}`;
          const entry = object(item, itemPath);
          known(entry, itemPath, [
            "product_node_id",
            "price_node_id",
            "quantity_node_id",
          ]);
          return {
            product_node_id: str(entry, "product_node_id", itemPath),
            price_node_id: str(entry, "price_node_id", itemPath),
            quantity_node_id: str(entry, "quantity_node_id", itemPath),
          };
        },
      ),
    };
  }
  return out;
}

function decodeContent(value: unknown, path: string): NodeContent {
  if (value === undefined || value === null) return {};
  const source = object(value, path);
  known(source, path, [
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
  ]);
  const out: NodeContent = {};
  const present = (key: string) =>
    source[key] !== undefined && source[key] !== null;

  if (present("heading")) {
    const inner = object(source.heading, path + "/heading");
    known(inner, path + "/heading", ["level", "text"]);
    out.heading = {
      level: int(inner, "level", path + "/heading"),
      text: decodeRichText(inner.text, path + "/heading/text"),
    };
  }
  if (present("paragraph")) {
    const inner = object(source.paragraph, path + "/paragraph");
    known(inner, path + "/paragraph", ["text"]);
    out.paragraph = { text: decodeRichText(inner.text, path + "/paragraph/text") };
  }
  if (present("list")) {
    const inner = object(source.list, path + "/list");
    known(inner, path + "/list", ["ordered", "items"]);
    out.list = {
      ordered: bool(inner, "ordered", path + "/list"),
      items: array(inner.items, path + "/list/items").map((item, index) =>
        decodeRichText(item, `${path}/list/items/${index}`),
      ),
    };
  }
  if (present("answer")) {
    const inner = object(source.answer, path + "/answer");
    known(inner, path + "/answer", ["question", "answer"]);
    out.answer = {
      question: decodeRichText(inner.question, path + "/answer/question"),
      answer: decodeRichText(inner.answer, path + "/answer/answer"),
    };
  }
  if (present("legal")) {
    const inner = object(source.legal, path + "/legal");
    known(inner, path + "/legal", ["text"]);
    out.legal = { text: decodeRichText(inner.text, path + "/legal/text") };
  }
  if (present("action")) {
    const inner = object(source.action, path + "/action");
    known(inner, path + "/action", [
      "action_id",
      "label",
      "canonical_url",
      "accessible_description",
    ]);
    out.action = {
      action_id: str(inner, "action_id", path + "/action"),
      label: str(inner, "label", path + "/action"),
      canonical_url: str(inner, "canonical_url", path + "/action"),
      accessible_description: str(inner, "accessible_description", path + "/action"),
    };
  }
  if (present("image")) {
    const inner = object(source.image, path + "/image");
    known(inner, path + "/image", ["url", "alt", "width", "height"]);
    out.image = {
      url: str(inner, "url", path + "/image"),
      alt: str(inner, "alt", path + "/image"),
      width: int(inner, "width", path + "/image"),
      height: int(inner, "height", path + "/image"),
    };
  }
  if (present("datetime")) {
    out.datetime = decodeDateTime(source.datetime, path + "/datetime");
  }
  if (present("money")) {
    const inner = object(source.money, path + "/money");
    known(inner, path + "/money", ["display_value", "amount", "currency"]);
    out.money = {
      display_value: str(inner, "display_value", path + "/money"),
      amount: str(inner, "amount", path + "/money"),
      currency: str(inner, "currency", path + "/money"),
    };
  }
  if (present("deadline")) {
    out.deadline = decodeDateTime(source.deadline, path + "/deadline");
  }
  if (present("offer")) {
    const offerPath = path + "/offer";
    const inner = object(source.offer, offerPath);
    known(inner, offerPath, [
      "description",
      "code",
      "terms",
      "availability_starts",
      "availability_ends",
      "canonical_offer_id",
    ]);
    out.offer = {
      description: decodeRichText(inner.description, offerPath + "/description"),
      code: str(inner, "code", offerPath),
      terms: decodeRichText(inner.terms, offerPath + "/terms"),
      availability_starts:
        inner.availability_starts === undefined ||
        inner.availability_starts === null
          ? null
          : decodeDateTime(
              inner.availability_starts,
              offerPath + "/availability_starts",
            ),
      availability_ends:
        inner.availability_ends === undefined || inner.availability_ends === null
          ? null
          : decodeDateTime(inner.availability_ends, offerPath + "/availability_ends"),
      canonical_offer_id: str(inner, "canonical_offer_id", offerPath),
    };
  }
  if (present("location")) {
    const locationPath = path + "/location";
    const inner = object(source.location, locationPath);
    known(inner, locationPath, ["name", "address"]);
    const addressPath = locationPath + "/address";
    const address = object(inner.address ?? {}, addressPath);
    known(address, addressPath, [
      "street_address",
      "address_locality",
      "address_region",
      "postal_code",
      "address_country",
    ]);
    out.location = {
      name: str(inner, "name", locationPath),
      address: {
        street_address: str(address, "street_address", addressPath),
        address_locality: str(address, "address_locality", addressPath),
        address_region: str(address, "address_region", addressPath),
        postal_code: str(address, "postal_code", addressPath),
        address_country: str(address, "address_country", addressPath),
      },
    };
  }
  if (present("product")) {
    const productPath = path + "/product";
    const inner = object(source.product, productPath);
    known(inner, productPath, ["name", "sku", "canonical_url", "image_url"]);
    out.product = {
      name: str(inner, "name", productPath),
      sku: str(inner, "sku", productPath),
      canonical_url: str(inner, "canonical_url", productPath),
      image_url: str(inner, "image_url", productPath),
    };
  }
  if (present("fact")) {
    const inner = object(source.fact, path + "/fact");
    known(inner, path + "/fact", ["label", "value"]);
    out.fact = {
      label: str(inner, "label", path + "/fact"),
      value: str(inner, "value", path + "/fact"),
    };
  }
  if (present("personalization")) {
    const personalizationPath = path + "/personalization";
    const inner = object(source.personalization, personalizationPath);
    known(inner, personalizationPath, ["label", "slot"]);
    out.personalization = {
      label: str(inner, "label", personalizationPath),
      slot: decodeSlot(inner.slot ?? {}, personalizationPath + "/slot"),
    };
  }
  if (present("structured_data")) {
    const structuredPath = path + "/structured_data";
    const inner = object(source.structured_data, structuredPath);
    known(inner, structuredPath, [
      "enabled",
      "provider",
      "registry_version",
      "use_case",
      "kind",
      "declaration",
    ]);
    out.structured_data = {
      enabled: bool(inner, "enabled", structuredPath),
      provider: str(inner, "provider", structuredPath),
      registry_version: str(inner, "registry_version", structuredPath),
      use_case: str(inner, "use_case", structuredPath),
      kind: str(inner, "kind", structuredPath),
      declaration: decodeDeclaration(
        inner.declaration ?? {},
        structuredPath + "/declaration",
      ),
    };
  }
  if (present("divider")) {
    const inner = object(source.divider, path + "/divider");
    known(inner, path + "/divider", []);
    out.divider = {};
  }
  if (present("poll")) {
    const pollPath = path + "/poll";
    const inner = object(source.poll, pollPath);
    known(inner, pollPath, ["poll_id", "question", "options"]);
    out.poll = {
      poll_id: str(inner, "poll_id", pollPath),
      question: decodeRichText(inner.question, pollPath + "/question"),
      options: array(inner.options, pollPath + "/options").map(
        (option, index): PollOption => {
          const optionPath = `${pollPath}/options/${index}`;
          const entry = object(option, optionPath);
          known(entry, optionPath, ["option_id", "label"]);
          return {
            option_id: str(entry, "option_id", optionPath),
            label: decodeRichText(entry.label, optionPath + "/label"),
          };
        },
      ),
    };
  }
  return out;
}

function decodeNode(value: unknown, path: string): SemanticNode {
  const source = object(value, path);
  known(source, path, [
    "id",
    "type",
    "role",
    "version",
    "content",
    "conditions",
    "localizations",
    "provenance",
  ]);
  const provenancePath = path + "/provenance";
  const provenance = object(source.provenance ?? {}, provenancePath);
  known(provenance, provenancePath, ["source", "source_id"]);

  const localizations: Record<string, NodeContent> = {};
  if (source.localizations !== undefined && source.localizations !== null) {
    const localizationsPath = path + "/localizations";
    const raw = object(source.localizations, localizationsPath);
    for (const locale of Object.keys(raw)) {
      localizations[locale] = decodeContent(
        raw[locale],
        `${localizationsPath}/${locale}`,
      );
    }
  }

  return {
    id: str(source, "id", path),
    type: str(source, "type", path),
    role: str(source, "role", path),
    version: int(source, "version", path),
    content: decodeContent(source.content, path + "/content"),
    conditions: array(source.conditions, path + "/conditions").map(
      (condition, index): Condition => {
        const conditionPath = `${path}/conditions/${index}`;
        const entry = object(condition, conditionPath);
        known(entry, conditionPath, ["id", "slot_id", "operator", "value"]);
        return {
          id: str(entry, "id", conditionPath),
          slot_id: str(entry, "slot_id", conditionPath),
          operator: str(entry, "operator", conditionPath),
          value: str(entry, "value", conditionPath),
        };
      },
    ),
    localizations,
    provenance: {
      source: str(provenance, "source", provenancePath),
      source_id: str(provenance, "source_id", provenancePath),
    },
  };
}

export interface DecodeResult {
  nodes: SemanticNode[] | null;
  diagnostics: Diagnostic[];
}

/**
 * Decodes the stored node array. Returns nodes: null with one invalid_json
 * diagnostic when the payload contains anything this editor cannot round-trip,
 * which is the same shape the API returns for the same input.
 */
export function decodeSemanticNodes(raw: unknown): DecodeResult {
  if (!Array.isArray(raw)) {
    return {
      nodes: null,
      diagnostics: [
        {
          severity: "error",
          code: "invalid_json",
          path: "/",
          message: "semantic node JSON must be an array of nodes",
        },
      ],
    };
  }
  try {
    return {
      nodes: raw.map((node, index) => decodeNode(node, `/${index}`)),
      diagnostics: [],
    };
  } catch (error) {
    if (error instanceof DecodeError) {
      return {
        nodes: null,
        diagnostics: [
          {
            severity: "error",
            code: "invalid_json",
            path: "/",
            message: "semantic node JSON could not be decoded: " + error.message,
          },
        ],
      };
    }
    throw error;
  }
}

export { wireNodes as encodeSemanticNodes } from "./wire";
