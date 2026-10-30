// SPDX-License-Identifier: AGPL-3.0-only
//
// Authoring operations for the semantic block editor.
//
// Every node the editor creates comes from createNode(), which is typed
// against the closed union: the type/role/content triple is chosen together,
// so there is no code path that produces a node whose content member does not
// match its declared type, or whose role is not in that type's set. The
// property editors then only ever change values INSIDE the member the factory
// picked.
//
// The other half of that guarantee is stageNodes(): the block editor cannot
// hand an invalid tree to the campaign draft. Validation runs on every change
// for inline field errors, and the same diagnostics gate the hand-off.

import { encodeSemanticNodes, documentFromNodes } from "./decode";
import { normalizeDocument } from "./normalize";
import {
  hasErrors,
  ROLES_BY_TYPE,
  type Diagnostic,
  type NodeContent,
  type NodeRole,
  type NodeType,
  type RichText,
  type SemanticNode,
  type SlotReference,
} from "./types";
import { normalizationDiagnostics, validateNormalizedDocument } from "./validate";

export function richText(text: string): RichText {
  return {
    runs: [{ kind: "text", text, url: "", accessible_label: "", slot: null }],
  };
}

export function emptyRichText(): RichText {
  return { runs: [] };
}

export function defaultSlot(): SlotReference {
  return { id: "first_name", semantic_class: "name", required: false, fallback: "" };
}

/** Human labels for the palette. */
export const NODE_TYPE_LABELS: Readonly<Record<NodeType, string>> = {
  heading: "Heading",
  paragraph: "Paragraph",
  list: "List",
  answer: "Question & answer",
  legal: "Legal / footer",
  action: "Action",
  image: "Image",
  datetime: "Date & time",
  money: "Price",
  deadline: "Deadline",
  offer: "Offer",
  location: "Location",
  product: "Product",
  fact: "Fact",
  personalization: "Personalization",
  structured_data: "Structured data",
  divider: "Divider",
  poll: "Poll",
};

export const NODE_TYPE_HINTS: Readonly<Record<NodeType, string>> = {
  heading: "Section title",
  paragraph: "Body copy",
  list: "Ordered or bulleted points",
  answer: "A question with its answer",
  legal: "Terms, address, small print",
  action: "A link the reader is asked to follow",
  image: "Informative or decorative",
  datetime: "An event time with its zone",
  money: "An exact amount and currency",
  deadline: "When something stops being true",
  offer: "A discount with terms and a window",
  location: "A named place with a postal address",
  product: "A named item with SKU and link",
  fact: "A labelled value",
  personalization: "A bounded runtime substitution",
  structured_data: "Provider markup declared from visible nodes",
  divider: "Decoration; dropped from plain text",
  poll: "A question with mutually exclusive options",
};

export const NODE_ROLE_LABELS: Readonly<Record<NodeRole, string>> = {
  heading: "Heading",
  body: "Body",
  answer: "Answer",
  legal: "Legal",
  footer: "Footer",
  primary_action: "Primary action",
  secondary_action: "Secondary action",
  unsubscribe: "Unsubscribe",
  preferences: "Preferences",
  view_in_browser: "View in browser",
  social: "Social",
  contact: "Contact",
  informative_image: "Informative image",
  decorative_image: "Decorative image",
  event_datetime: "Event date & time",
  price: "Price",
  deadline: "Deadline",
  offer: "Offer",
  location: "Location",
  product: "Product",
  product_fact: "Product fact",
  personalization_slot: "Personalization slot",
  structured_data: "Structured data",
  divider: "Divider",
  poll: "Poll",
};

function defaultContent(type: NodeType, suffix: string): NodeContent {
  switch (type) {
    case "heading":
      return { heading: { level: 2, text: richText("Section heading") } };
    case "paragraph":
      return { paragraph: { text: richText("Body copy.") } };
    case "list":
      return {
        list: { ordered: false, items: [richText("First point")] },
      };
    case "answer":
      return {
        answer: { question: richText("Question?"), answer: richText("Answer.") },
      };
    case "legal":
      return { legal: { text: richText("Terms apply.") } };
    case "action":
      return {
        action: {
          action_id: `act_${suffix}`,
          label: "Read more",
          // A new action is intentionally incomplete until its real
          // destination is supplied. A plausible-looking example.com value can
          // otherwise survive author review and become a live email link.
          canonical_url: "",
          accessible_description: "",
        },
      };
    case "image":
      return {
        image: {
          url: "",
          alt: "Describe this image",
          width: 0,
          height: 0,
        },
      };
    case "datetime":
    case "deadline": {
      const value = {
        display_value: "",
        rfc3339: "",
        timezone: defaultTimezone(),
      };
      return type === "datetime" ? { datetime: value } : { deadline: value };
    }
    case "money":
      return { money: { display_value: "", amount: "", currency: "USD" } };
    case "offer":
      return {
        offer: {
          description: richText("Save on your next order"),
          code: "",
          terms: emptyRichText(),
          availability_starts: null,
          availability_ends: null,
          canonical_offer_id: "",
        },
      };
    case "location":
      return {
        location: {
          name: "",
          address: {
            street_address: "",
            address_locality: "",
            address_region: "",
            postal_code: "",
            address_country: "",
          },
        },
      };
    case "product":
      return { product: { name: "", sku: "", canonical_url: "", image_url: "" } };
    case "fact":
      return { fact: { label: "", value: "" } };
    case "personalization":
      return { personalization: { label: "", slot: defaultSlot() } };
    case "structured_data":
      return {
        structured_data: {
          enabled: true,
          provider: "gmail",
          registry_version: "gmail.email-markup.2026-04-20",
          use_case: "gmail_promotion",
          kind: "discount_offer",
          declaration: { discount_offer: { offer_node_id: "" } },
        },
      };
    case "divider":
      return { divider: {} };
    case "poll":
      return {
        poll: {
          poll_id: `poll_${suffix}`,
          question: richText("Which do you prefer?"),
          // Two options, with distinct ids, because that is the minimum that
          // makes a poll a question and the minimum that makes a tally mean
          // anything.
          options: [
            { option_id: "option_1", label: richText("First option") },
            { option_id: "option_2", label: richText("Second option") },
          ],
        },
      };
  }
}

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Builds one node of the requested type with its only-possible-shape content
 * and the first role that type allows. `suffix` makes generated stable
 * references unique; the caller passes something short and collision-free.
 */
export function createNode(type: NodeType, suffix: string): SemanticNode {
  return {
    id: `${type}_${suffix}`,
    type,
    role: ROLES_BY_TYPE[type][0],
    version: 2,
    content: defaultContent(type, suffix),
    conditions: [],
    localizations: {},
    provenance: { source: "user", source_id: "" },
  };
}

export function insertNodeAt(
  nodes: readonly SemanticNode[],
  node: SemanticNode,
  index?: number,
): SemanticNode[] {
  const out = [...nodes];
  const at = index === undefined ? out.length : Math.max(0, Math.min(index, out.length));
  out.splice(at, 0, node);
  return out;
}

export function removeNodeAt(
  nodes: readonly SemanticNode[],
  index: number,
): SemanticNode[] {
  if (index < 0 || index >= nodes.length) return [...nodes];
  const out = [...nodes];
  out.splice(index, 1);
  return out;
}

/** Swaps a node with its neighbour; the keyboard reorder path. */
export function moveNode(
  nodes: readonly SemanticNode[],
  index: number,
  direction: -1 | 1,
): SemanticNode[] {
  const target = index + direction;
  if (index < 0 || index >= nodes.length || target < 0 || target >= nodes.length) {
    return [...nodes];
  }
  const out = [...nodes];
  [out[index], out[target]] = [out[target], out[index]];
  return out;
}

/** Moves a node into another node's slot; the drag-to-position path. */
export function reorderNode(
  nodes: readonly SemanticNode[],
  from: number,
  to: number,
): SemanticNode[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= nodes.length ||
    to >= nodes.length
  ) {
    return [...nodes];
  }
  const out = [...nodes];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

export function duplicateNodeAt(
  nodes: readonly SemanticNode[],
  index: number,
  suffix: string,
): SemanticNode[] {
  if (index < 0 || index >= nodes.length) return [...nodes];
  const source = nodes[index];
  const clone: SemanticNode = JSON.parse(
    JSON.stringify(source),
  ) as SemanticNode;
  clone.id = `${source.type}_${suffix}`;
  // Identity that a response, a receipt, or a tally hangs on must not be
  // duplicated: a copied action id collapses two CTAs into one attribution and
  // a copied poll id collapses two questions into one tally.
  if (clone.content.action) clone.content.action.action_id = `act_${suffix}`;
  if (clone.content.poll) clone.content.poll.poll_id = `poll_${suffix}`;
  return insertNodeAt(nodes, clone, index + 1);
}

/** Validates the node array in the same document context the API wraps it in. */
export function validateNodes(nodes: readonly SemanticNode[]): Diagnostic[] {
  const document = documentFromNodes([...nodes]);
  return [
    ...normalizationDiagnostics(document),
    ...validateNormalizedDocument(normalizeDocument(document)),
  ];
}

export interface StageResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  nodes: Array<Record<string, unknown>> | null;
}

/**
 * The hand-off to the campaign draft. It refuses on any error diagnostic, so
 * the block editor structurally cannot stage a tree the API would reject —
 * warnings (a skipped heading level, a second h1) are advisory and do not
 * block, exactly as they do not block on the server.
 */
export function stageNodes(nodes: readonly SemanticNode[]): StageResult {
  const diagnostics = validateNodes(nodes);
  if (hasErrors(diagnostics)) {
    return { ok: false, diagnostics, nodes: null };
  }
  return { ok: true, diagnostics, nodes: encodeSemanticNodes(nodes) };
}

/** Diagnostics that address a node, keyed by its JSON Pointer prefix. */
export function diagnosticsByNodeIndex(
  diagnostics: readonly Diagnostic[],
  count: number,
): Diagnostic[][] {
  const byIndex: Diagnostic[][] = Array.from({ length: count }, () => []);
  for (const diagnostic of diagnostics) {
    const match = /^\/nodes\/(\d+)(\/|$)/.exec(diagnostic.path);
    if (!match) continue;
    const index = Number(match[1]);
    if (index >= 0 && index < count) byIndex[index].push(diagnostic);
  }
  return byIndex;
}

/** Diagnostics that are about the document rather than one node. */
export function documentDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) => !/^\/nodes\/\d+(\/|$)/.test(diagnostic.path),
  );
}

/**
 * Finds the diagnostics one control should render.
 *
 * "exact" is the default on purpose. A subtree match at, say,
 * /nodes/0/content/poll/options would repeat every per-option error that the
 * option's own field is already showing, and an error shown three times reads
 * as three errors. Subtree matching is opt-in, for the few pointers whose
 * children have no control of their own.
 */
export function diagnosticsForField(
  diagnostics: readonly Diagnostic[],
  pointer: string,
  mode: "exact" | "subtree" = "exact",
): Diagnostic[] {
  return diagnostics.filter((diagnostic) =>
    mode === "exact"
      ? diagnostic.path === pointer
      : diagnostic.path === pointer || diagnostic.path.startsWith(pointer + "/"),
  );
}
