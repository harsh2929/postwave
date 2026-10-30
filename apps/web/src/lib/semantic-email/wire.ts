// SPDX-License-Identifier: AGPL-3.0-only
//
// Serialization back to the exact JSON shape the API stores.
//
// This mirrors Go's `omitempty` struct tags field by field. It matters for a
// reason beyond tidiness: campaigns.content_blocks is canonicalized and HASHED
// on the server, and the artifact receipt names that hash. A payload that
// carried `"sku": ""` where the stored document has no `sku` at all is a
// different document by that definition, and the editor would be re-writing
// every node it merely opened.

import type {
  Condition,
  DateTimeContent,
  NodeContent,
  RichText,
  SemanticDocument,
  SemanticNode,
  SlotReference,
  StructuredDeclaration,
} from "./types";

type JSONObject = Record<string, unknown>;

function put(target: JSONObject, key: string, value: string | number | boolean) {
  // omitempty: the zero value is absent, not present-and-empty.
  if (value === "" || value === 0 || value === false) return;
  target[key] = value;
}

function wireSlot(slot: SlotReference): JSONObject {
  const out: JSONObject = {
    id: slot.id,
    semantic_class: slot.semantic_class,
    required: slot.required,
  };
  put(out, "fallback", slot.fallback);
  return out;
}

function wireRichText(rich: RichText): JSONObject {
  return {
    runs: rich.runs.map((run) => {
      const out: JSONObject = { kind: run.kind };
      put(out, "text", run.text);
      put(out, "url", run.url);
      put(out, "accessible_label", run.accessible_label);
      if (run.slot) out.slot = wireSlot(run.slot);
      return out;
    }),
  };
}

function wireDateTime(value: DateTimeContent): JSONObject {
  return {
    display_value: value.display_value,
    rfc3339: value.rfc3339,
    timezone: value.timezone,
  };
}

function wireDeclaration(declaration: StructuredDeclaration): JSONObject {
  const out: JSONObject = {};
  if (declaration.discount_offer) {
    out.discount_offer = {
      offer_node_id: declaration.discount_offer.offer_node_id,
    };
  }
  if (declaration.promotion_card) {
    const card = declaration.promotion_card;
    const value: JSONObject = {
      image_node_id: card.image_node_id,
      action_node_id: card.action_node_id,
    };
    put(value, "headline_node_id", card.headline_node_id);
    put(value, "price_node_id", card.price_node_id);
    put(value, "discount_value_node_id", card.discount_value_node_id);
    put(value, "position", card.position);
    out.promotion_card = value;
  }
  if (declaration.event_reservation) {
    const reservation = declaration.event_reservation;
    const value: JSONObject = {
      reservation_number_node_id: reservation.reservation_number_node_id,
      under_name_node_id: reservation.under_name_node_id,
      event_name_node_id: reservation.event_name_node_id,
      start_datetime_node_id: reservation.start_datetime_node_id,
      location_node_id: reservation.location_node_id,
      status_node_id: reservation.status_node_id,
      status: reservation.status,
    };
    put(value, "action_node_id", reservation.action_node_id);
    out.event_reservation = value;
  }
  if (declaration.order) {
    const order = declaration.order;
    const value: JSONObject = {
      merchant_node_id: order.merchant_node_id,
      order_number_node_id: order.order_number_node_id,
      total_node_id: order.total_node_id,
      items: order.items.map((item) => ({
        product_node_id: item.product_node_id,
        price_node_id: item.price_node_id,
        quantity_node_id: item.quantity_node_id,
      })),
    };
    put(value, "action_node_id", order.action_node_id);
    out.order = value;
  }
  return out;
}

export function wireContent(content: NodeContent): JSONObject {
  const out: JSONObject = {};
  if (content.heading) {
    out.heading = {
      level: content.heading.level,
      text: wireRichText(content.heading.text),
    };
  }
  if (content.paragraph) {
    out.paragraph = { text: wireRichText(content.paragraph.text) };
  }
  if (content.list) {
    out.list = {
      ordered: content.list.ordered,
      items: content.list.items.map(wireRichText),
    };
  }
  if (content.answer) {
    out.answer = {
      question: wireRichText(content.answer.question),
      answer: wireRichText(content.answer.answer),
    };
  }
  if (content.legal) out.legal = { text: wireRichText(content.legal.text) };
  if (content.action) {
    const value: JSONObject = {
      action_id: content.action.action_id,
      label: content.action.label,
      canonical_url: content.action.canonical_url,
    };
    put(value, "accessible_description", content.action.accessible_description);
    out.action = value;
  }
  if (content.image) {
    const value: JSONObject = {
      url: content.image.url,
      alt: content.image.alt,
    };
    put(value, "width", content.image.width);
    put(value, "height", content.image.height);
    out.image = value;
  }
  if (content.datetime) out.datetime = wireDateTime(content.datetime);
  if (content.money) {
    out.money = {
      display_value: content.money.display_value,
      amount: content.money.amount,
      currency: content.money.currency,
    };
  }
  if (content.deadline) out.deadline = wireDateTime(content.deadline);
  if (content.offer) {
    const value: JSONObject = {
      description: wireRichText(content.offer.description),
    };
    put(value, "code", content.offer.code);
    value.terms = wireRichText(content.offer.terms);
    if (content.offer.availability_starts) {
      value.availability_starts = wireDateTime(content.offer.availability_starts);
    }
    if (content.offer.availability_ends) {
      value.availability_ends = wireDateTime(content.offer.availability_ends);
    }
    put(value, "canonical_offer_id", content.offer.canonical_offer_id);
    out.offer = value;
  }
  if (content.location) {
    const address: JSONObject = {
      street_address: content.location.address.street_address,
      address_locality: content.location.address.address_locality,
    };
    put(address, "address_region", content.location.address.address_region);
    put(address, "postal_code", content.location.address.postal_code);
    address.address_country = content.location.address.address_country;
    out.location = { name: content.location.name, address };
  }
  if (content.product) {
    const value: JSONObject = { name: content.product.name };
    put(value, "sku", content.product.sku);
    put(value, "canonical_url", content.product.canonical_url);
    put(value, "image_url", content.product.image_url);
    out.product = value;
  }
  if (content.fact) {
    out.fact = { label: content.fact.label, value: content.fact.value };
  }
  if (content.personalization) {
    const value: JSONObject = {};
    put(value, "label", content.personalization.label);
    value.slot = wireSlot(content.personalization.slot);
    out.personalization = value;
  }
  if (content.structured_data) {
    const structured = content.structured_data;
    // `enabled` carries no omitempty in Go: a declaration the author switched
    // OFF must survive the round trip as an explicit false, not vanish and be
    // re-read as an absent field.
    const value: JSONObject = { enabled: structured.enabled };
    value.provider = structured.provider;
    value.registry_version = structured.registry_version;
    value.use_case = structured.use_case;
    value.kind = structured.kind;
    value.declaration = wireDeclaration(structured.declaration);
    out.structured_data = value;
  }
  if (content.divider) out.divider = {};
  if (content.poll) {
    out.poll = {
      poll_id: content.poll.poll_id,
      question: wireRichText(content.poll.question),
      options: content.poll.options.map((option) => ({
        option_id: option.option_id,
        label: wireRichText(option.label),
      })),
    };
  }
  return out;
}

function wireCondition(condition: Condition): JSONObject {
  const out: JSONObject = {
    id: condition.id,
    slot_id: condition.slot_id,
    operator: condition.operator,
  };
  put(out, "value", condition.value);
  return out;
}

export function wireNode(node: SemanticNode): JSONObject {
  const provenance: JSONObject = { source: node.provenance.source };
  put(provenance, "source_id", node.provenance.source_id);
  return {
    id: node.id,
    type: node.type,
    role: node.role,
    version: node.version,
    content: wireContent(node.content),
    conditions: node.conditions.map(wireCondition),
    localizations: Object.fromEntries(
      Object.keys(node.localizations)
        .sort()
        .map((locale) => [locale, wireContent(node.localizations[locale])]),
    ),
    provenance,
  };
}

export function wireNodes(nodes: readonly SemanticNode[]): JSONObject[] {
  return nodes.map(wireNode);
}

export function wireDocument(document: SemanticDocument): JSONObject {
  return {
    schema_version: document.schema_version,
    language: document.language,
    direction: document.direction,
    nodes: wireNodes(document.nodes),
  };
}
