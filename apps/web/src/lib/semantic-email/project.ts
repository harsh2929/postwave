// SPDX-License-Identifier: AGPL-3.0-only
//
// Mirror of CompileV2's resolution pass (compile.go) and both projections
// (render.go), so the editor can show the author the message the API will
// actually send.
//
// COULD THIS HAVE REUSED THE SERVER'S RENDERER INSTEAD? No, and it is worth
// being precise about why. The projections live in Go, and there is no HTTP
// surface that compiles an UNSAVED tree: the only semantic compile paths are
// revision freeze (POST /api/v1/campaigns/{id}/content-revisions, which mints
// an immutable revision) and assurance runs, which operate on a revision that
// already exists. Previewing by freezing a revision on every keystroke would
// mint garbage immutable content and burn assurance runs. Adding a compile
// endpoint was out of scope for this package.
//
// So this is a second implementation, which is exactly the thing that drifts.
// It is held to the original by a differential test: scripts/
// regen-semantic-projection-fixtures.sh runs a corpus through the REAL Go
// compiler and records the bytes, and semantic-email-go-parity.test.ts asserts
// these functions reproduce them. The mirror cannot drift silently; it can
// only drift loudly, in CI, the moment someone regenerates.
//
// One deliberate difference, and it is not drift: provider markup (the Gmail
// JSON-LD <script>) is never emitted here. The Go renderer only emits it when
// sender-eligibility evidence proves the annotation would be honoured, and a
// draft editor holds no such evidence — the same zero policy the fixtures are
// generated with. structured_data nodes therefore contribute nothing visible,
// which is what a reader would see.

import {
  escapeHTML,
  goTrimSpace,
  hasControlCharacter,
  isValidUTF8,
  runeCount,
  utf8ByteLength,
} from "./go-text";
import {
  normalizeDocument,
  normalizeLanguage,
  normalizeNaturalText,
  normalizeReference,
} from "./normalize";
import {
  escapeJSONPointer,
  type Diagnostic,
  type DiagnosticCode,
  type NodeContent,
  type PostalAddress,
  type RichText,
  type SemanticDocument,
  type SemanticNode,
  type SlotReference,
} from "./types";
import {
  isCanonicalLanguageTag,
  normalizationDiagnostics,
  validateNormalizedDocument,
} from "./validate";

const MAX_COMPILED_TEXT_BYTES = 2 << 20;
const MAX_COMPILED_HTML_BYTES = 8 << 20;
const MAX_SLOT_VALUE_RUNES = 16_384;

/**
 * The one action the message is asking for gets a marker and a line of its
 * own, so it is not typographically identical to the unsubscribe link in the
 * representation AI summarisers prefer.
 */
const PRIMARY_ACTION_MARKER = "==>";

export interface CompileOptions {
  locale?: string;
  /** Scenario fixture values for personalization slots and conditions. */
  slots?: Record<string, string>;
}

export interface CompileResult {
  html: string;
  text: string;
  includedNodeIDs: string[];
  diagnostics: Diagnostic[];
  ok: boolean;
}

interface ResolvedNode {
  node: SemanticNode;
  content: NodeContent;
}

class CompileSink {
  readonly items: Diagnostic[];

  constructor(initial: Diagnostic[]) {
    this.items = initial;
  }

  error(path: string, nodeID: string, code: DiagnosticCode, message: string) {
    this.items.push({
      severity: "error",
      code,
      path,
      ...(nodeID ? { node_id: nodeID } : {}),
      message,
    });
  }

  warning(path: string, nodeID: string, code: DiagnosticCode, message: string) {
    this.items.push({
      severity: "warning",
      code,
      path,
      ...(nodeID ? { node_id: nodeID } : {}),
      message,
    });
  }

  warningOnce(
    path: string,
    nodeID: string,
    code: DiagnosticCode,
    message: string,
  ) {
    if (
      this.items.some(
        (item) =>
          item.severity === "warning" && item.path === path && item.code === code,
      )
    ) {
      return;
    }
    this.warning(path, nodeID, code, message);
  }

  hasErrors(): boolean {
    return this.items.some((item) => item.severity === "error");
  }
}

/** Mirrors CompileV2 for the projections a draft preview can know about. */
export function compileDocument(
  input: SemanticDocument,
  options: CompileOptions = {},
): CompileResult {
  const document = normalizeDocument(input);
  const sink = new CompileSink([
    ...normalizationDiagnostics(input),
    ...validateNormalizedDocument(document),
  ]);
  if (sink.hasErrors()) {
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }

  let locale = normalizeLanguage(options.locale ?? "");
  const slots = normalizeCompileSlots(options.slots ?? {}, sink);
  if (locale === "") locale = document.language;
  validateCompileLocale(sink, locale);
  if (sink.hasErrors()) {
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }

  const resolved: ResolvedNode[] = [];
  document.nodes.forEach((node, index) => {
    if (!evaluateConditions(sink, slots, index, node)) return;
    const localized = selectLocalizedContent(sink, document, locale, index, node);
    if (localized === null) return;
    resolved.push({
      node,
      content: resolveContent(sink, slots, index, node.id, localized),
    });
  });
  validateResolvedStructure(sink, document, resolved);
  if (sink.hasErrors()) {
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }
  const visible = resolved.some((item) => item.node.type !== "structured_data");
  if (!visible) {
    sink.error(
      "/nodes",
      "",
      "no_visible_content",
      "compiled scenario contains no visible semantic content",
    );
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }

  reportUnverifiedStructuredData(sink, document, resolved);
  if (sink.hasErrors()) {
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }

  const html = renderHTML(document.direction, locale, resolved);
  const text = renderText(resolved);
  if (goTrimSpace(text) === "") {
    sink.error(
      "/compile/text",
      "",
      "no_visible_content",
      "compiled scenario has no semantic plain-text content",
    );
  }
  if (utf8ByteLength(html) > MAX_COMPILED_HTML_BYTES) {
    sink.error(
      "/compile/html",
      "",
      "limit_exceeded",
      `compiled HTML exceeds ${MAX_COMPILED_HTML_BYTES} bytes`,
    );
  }
  if (utf8ByteLength(text) > MAX_COMPILED_TEXT_BYTES) {
    sink.error(
      "/compile/text",
      "",
      "limit_exceeded",
      `compiled text exceeds ${MAX_COMPILED_TEXT_BYTES} bytes`,
    );
  }
  if (sink.hasErrors()) {
    return { html: "", text: "", includedNodeIDs: [], diagnostics: sink.items, ok: false };
  }
  return {
    html,
    text,
    includedNodeIDs: resolved.map((item) => item.node.id),
    diagnostics: sink.items,
    ok: true,
  };
}

function validateCompileLocale(sink: CompileSink, locale: string) {
  if (locale === "") {
    sink.error("/compile/locale", "", "required", "language is required");
    return;
  }
  if (!isCanonicalLanguageTag(locale)) {
    sink.error(
      "/compile/locale",
      "",
      "invalid_language",
      "language must be a canonical, specific BCP 47 tag",
    );
  }
}

function normalizeCompileSlots(
  input: Record<string, string>,
  sink: CompileSink,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of Object.keys(input).sort()) {
    const id = normalizeReference(raw);
    const path = "/compile/slots/" + escapeJSONPointer(raw);
    if (id === "") {
      sink.error(path, "", "required", "stable reference is required");
      continue;
    }
    if (out.has(id)) {
      sink.error(path, "", "duplicate", "slot id collides after normalization");
      continue;
    }
    const value = input[raw];
    if (
      !isValidUTF8(value) ||
      runeCount(value) > MAX_SLOT_VALUE_RUNES ||
      hasControlCharacter(value)
    ) {
      sink.error(
        path,
        "",
        "slot_value_invalid",
        `slot value must be valid UTF-8, control-free, and at most ${MAX_SLOT_VALUE_RUNES} characters`,
      );
      continue;
    }
    out.set(id, normalizeNaturalText(value));
  }
  return out;
}

function evaluateConditions(
  sink: CompileSink,
  slots: Map<string, string>,
  index: number,
  node: SemanticNode,
): boolean {
  let included = true;
  node.conditions.forEach((condition, conditionIndex) => {
    const path = `/nodes/${index}/conditions/${conditionIndex}`;
    const exists = slots.has(condition.slot_id);
    const value = slots.get(condition.slot_id) ?? "";
    const present = exists && value !== "";
    switch (condition.operator) {
      case "present":
        included = included && present;
        break;
      case "absent":
        included = included && !present;
        break;
      case "equals":
      case "not_equals": {
        if (!exists) {
          sink.error(
            path + "/slot_id",
            node.id,
            "condition_unresolved",
            "equality condition cannot be resolved without a scenario slot value",
          );
          included = false;
          return;
        }
        let matches = value === condition.value;
        if (condition.operator === "not_equals") matches = !matches;
        included = included && matches;
        break;
      }
    }
  });
  return included;
}

function selectLocalizedContent(
  sink: CompileSink,
  document: SemanticDocument,
  locale: string,
  index: number,
  node: SemanticNode,
): NodeContent | null {
  if (locale === document.language || node.type === "structured_data") {
    return node.content;
  }
  const localized = node.localizations[locale];
  if (localized === undefined) {
    sink.error(
      `/nodes/${index}/localizations/${escapeJSONPointer(locale)}`,
      node.id,
      "locale_unavailable",
      "required scenario locale has no node localization",
    );
    return null;
  }
  return localized;
}

function resolveContent(
  sink: CompileSink,
  slots: Map<string, string>,
  index: number,
  nodeID: string,
  content: NodeContent,
): NodeContent {
  const base = `/nodes/${index}/content`;
  const out: NodeContent = { ...content };
  if (out.heading) {
    out.heading = {
      ...out.heading,
      text: resolveRichText(sink, slots, base + "/heading/text", nodeID, out.heading.text),
    };
  }
  if (out.paragraph) {
    out.paragraph = {
      text: resolveRichText(
        sink,
        slots,
        base + "/paragraph/text",
        nodeID,
        out.paragraph.text,
      ),
    };
  }
  if (out.list) {
    out.list = {
      ordered: out.list.ordered,
      items: out.list.items.map((item, itemIndex) =>
        resolveRichText(sink, slots, `${base}/list/items/${itemIndex}`, nodeID, item),
      ),
    };
  }
  if (out.answer) {
    out.answer = {
      question: resolveRichText(
        sink,
        slots,
        base + "/answer/question",
        nodeID,
        out.answer.question,
      ),
      answer: resolveRichText(
        sink,
        slots,
        base + "/answer/answer",
        nodeID,
        out.answer.answer,
      ),
    };
  }
  if (out.legal) {
    out.legal = {
      text: resolveRichText(sink, slots, base + "/legal/text", nodeID, out.legal.text),
    };
  }
  if (out.offer) {
    out.offer = {
      ...out.offer,
      description: resolveRichText(
        sink,
        slots,
        base + "/offer/description",
        nodeID,
        out.offer.description,
      ),
      terms: resolveRichText(sink, slots, base + "/offer/terms", nodeID, out.offer.terms),
    };
  }
  if (out.personalization) {
    const value = resolveSlot(
      sink,
      slots,
      base + "/personalization/slot",
      nodeID,
      out.personalization.slot,
    );
    out.personalization = {
      label: out.personalization.label,
      slot: { ...out.personalization.slot, required: false, fallback: value },
    };
  }
  return out;
}

function resolveRichText(
  sink: CompileSink,
  slots: Map<string, string>,
  path: string,
  nodeID: string,
  rich: RichText,
): RichText {
  const runs: RichText["runs"] = [];
  rich.runs.forEach((run, index) => {
    if (run.kind !== "slot" || run.slot === null) {
      runs.push(run);
      return;
    }
    const value = resolveSlot(sink, slots, `${path}/runs/${index}/slot`, nodeID, run.slot);
    if (value !== "") {
      runs.push({
        kind: "text",
        text: value,
        url: "",
        accessible_label: "",
        slot: null,
      });
    }
  });
  return { runs };
}

function resolveSlot(
  sink: CompileSink,
  slots: Map<string, string>,
  path: string,
  nodeID: string,
  slot: SlotReference,
): string {
  const value = slots.get(slot.id);
  if (value !== undefined && value !== "") return value;
  if (slot.fallback !== "") return slot.fallback;
  if (slot.required) {
    sink.error(
      path,
      nodeID,
      "slot_unresolved",
      "required personalization slot has no scenario value or fallback",
    );
  }
  return "";
}

function nodePath(document: SemanticDocument, nodeID: string): string {
  const index = document.nodes.findIndex((node) => node.id === nodeID);
  return index < 0 ? "/nodes" : `/nodes/${index}`;
}

function validateResolvedStructure(
  sink: CompileSink,
  document: SemanticDocument,
  resolved: ResolvedNode[],
) {
  let lastHeadingLevel = 0;
  let firstH1Path = "";
  let primaryActionPath = "";
  for (const item of resolved) {
    const path = nodePath(document, item.node.id);
    if (item.node.type === "heading" && item.content.heading) {
      const level = item.content.heading.level;
      if (level === 1) {
        if (firstH1Path !== "") {
          sink.warningOnce(
            path + "/content/heading/level",
            item.node.id,
            "multiple_top_level_headings",
            "compiled scenario contains more than one level-one heading; first is " +
              firstH1Path,
          );
        } else {
          firstH1Path = path + "/content/heading/level";
        }
      }
      if (level > 1 && (lastHeadingLevel === 0 || level > lastHeadingLevel + 1)) {
        sink.warningOnce(
          path + "/content/heading/level",
          item.node.id,
          "heading_level_skipped",
          "compiled heading hierarchy skips a level",
        );
      }
      lastHeadingLevel = level;
    }
    if (item.node.type === "action" && item.node.role === "primary_action") {
      if (primaryActionPath !== "") {
        sink.error(
          path + "/role",
          item.node.id,
          "multiple_primary_actions",
          "compiled scenario has another primary action at " + primaryActionPath,
        );
      } else {
        primaryActionPath = path + "/role";
      }
    }
  }
}

/**
 * A draft has no sender-eligibility evidence, so every enabled structured-data
 * declaration is unverified and nothing is emitted. This mirrors
 * compileStructuredData under the zero policy rather than reimplementing the
 * JSON-LD builders, which produce output the preview would not show anyway.
 */
function reportUnverifiedStructuredData(
  sink: CompileSink,
  document: SemanticDocument,
  resolved: ResolvedNode[],
) {
  for (const item of resolved) {
    if (item.node.type !== "structured_data" || !item.content.structured_data) {
      continue;
    }
    if (!item.content.structured_data.enabled) continue;
    sink.warning(
      nodePath(document, item.node.id) + "/content/structured_data",
      item.node.id,
      "structured_data_unverified",
      "Gmail sender registration is not verified; valid markup was not emitted",
    );
  }
}

// ---------------------------------------------------------------------------
// HTML projection — render.go
// ---------------------------------------------------------------------------

function renderHTML(
  direction: string,
  locale: string,
  nodes: ResolvedNode[],
): string {
  let out =
    '<!doctype html>\n<html lang="' +
    escapeHTML(locale) +
    '" dir="' +
    escapeHTML(direction) +
    '">\n<head>\n<meta charset="utf-8">\n';
  out += "</head>\n<body>\n<main>\n";
  for (const node of nodes) out += renderHTMLNode(node);
  out += "</main>\n</body>\n</html>\n";
  return out;
}

function renderHTMLNode(resolved: ResolvedNode): string {
  const { node, content } = resolved;
  if (node.type === "structured_data") return "";
  const attributes =
    ' data-postwave-node="' +
    escapeHTML(node.id) +
    '" data-postwave-role="' +
    escapeHTML(node.role) +
    '"';
  switch (node.type) {
    case "heading": {
      const tag = "h" + String(content.heading!.level);
      return (
        "<" +
        tag +
        attributes +
        ">" +
        renderHTMLRichText(content.heading!.text) +
        "</" +
        tag +
        ">\n"
      );
    }
    case "paragraph":
      return (
        "<p" +
        attributes +
        ">" +
        renderHTMLRichText(content.paragraph!.text) +
        "</p>\n"
      );
    case "list": {
      const tag = content.list!.ordered ? "ol" : "ul";
      let out = "<" + tag + attributes + ">\n";
      for (const item of content.list!.items) {
        out += "<li>" + renderHTMLRichText(item) + "</li>\n";
      }
      return out + "</" + tag + ">\n";
    }
    case "answer":
      return (
        "<section" +
        attributes +
        "><h2>" +
        renderHTMLRichText(content.answer!.question) +
        "</h2><p>" +
        renderHTMLRichText(content.answer!.answer) +
        "</p></section>\n"
      );
    case "legal":
      return (
        "<footer" +
        attributes +
        "><p>" +
        renderHTMLRichText(content.legal!.text) +
        "</p></footer>\n"
      );
    case "action": {
      const action = content.action!;
      let out =
        "<p" +
        attributes +
        '><a data-postwave-action-id="' +
        escapeHTML(action.action_id) +
        '" href="' +
        escapeHTML(action.canonical_url) +
        '"';
      if (action.accessible_description !== "") {
        out += ' aria-label="' + escapeHTML(action.accessible_description) + '"';
      }
      return out + ">" + escapeHTML(action.label) + "</a></p>\n";
    }
    case "image": {
      const image = content.image!;
      let out =
        "<figure" +
        attributes +
        '><img src="' +
        escapeHTML(image.url) +
        '" alt="' +
        escapeHTML(image.alt) +
        '"';
      if (node.role === "decorative_image") out += ' role="presentation"';
      if (image.width > 0) {
        out +=
          ' width="' +
          String(image.width) +
          '" height="' +
          String(image.height) +
          '"';
      }
      return out + "></figure>\n";
    }
    case "datetime":
      return renderHTMLTime(attributes, content.datetime!);
    case "deadline":
      return renderHTMLTime(attributes, content.deadline!);
    case "money": {
      const money = content.money!;
      return (
        "<p" +
        attributes +
        '><data value="' +
        escapeHTML(money.amount) +
        '" data-currency="' +
        escapeHTML(money.currency) +
        '">' +
        escapeHTML(money.display_value) +
        "</data></p>\n"
      );
    }
    case "offer": {
      const offer = content.offer!;
      let out =
        "<section" + attributes + "><p>" + renderHTMLRichText(offer.description) + "</p>";
      if (offer.code !== "") {
        out += "<p>Code: <code>" + escapeHTML(offer.code) + "</code></p>";
      }
      if (offer.terms.runs.length !== 0) {
        out += "<p>Terms: " + renderHTMLRichText(offer.terms) + "</p>";
      }
      if (offer.availability_starts) {
        out += "<p>Starts: " + renderInlineTime(offer.availability_starts) + "</p>";
      }
      if (offer.availability_ends) {
        out += "<p>Ends: " + renderInlineTime(offer.availability_ends) + "</p>";
      }
      return out + "</section>\n";
    }
    case "location": {
      const location = content.location!;
      return (
        "<address" +
        attributes +
        "><strong>" +
        escapeHTML(location.name) +
        "</strong><br>" +
        escapeHTML(formatAddress(location.address)) +
        "</address>\n"
      );
    }
    case "product": {
      const product = content.product!;
      let out = "<article" + attributes + ">";
      if (product.image_url !== "") {
        out +=
          '<img src="' +
          escapeHTML(product.image_url) +
          '" alt="' +
          escapeHTML("Product image: " + product.name) +
          '">';
      }
      out += "<p><strong>";
      if (product.canonical_url !== "") {
        out += '<a href="' + escapeHTML(product.canonical_url) + '">';
      }
      out += escapeHTML(product.name);
      if (product.canonical_url !== "") out += "</a>";
      out += "</strong>";
      if (product.sku !== "") {
        out += " <span>SKU: " + escapeHTML(product.sku) + "</span>";
      }
      return out + "</p></article>\n";
    }
    case "fact":
      return (
        "<p" +
        attributes +
        "><strong>" +
        escapeHTML(content.fact!.label) +
        ":</strong> " +
        escapeHTML(content.fact!.value) +
        "</p>\n"
      );
    case "personalization": {
      const personalization = content.personalization!;
      let out = "<p" + attributes + ">";
      if (personalization.label !== "") {
        out += "<strong>" + escapeHTML(personalization.label) + ":</strong> ";
      }
      return out + escapeHTML(personalization.slot.fallback) + "</p>\n";
    }
    case "divider":
      // role="presentation" so a screen reader skips it, matching what the
      // plain-text projection does by omitting it entirely.
      return "<hr" + attributes + ' role="presentation">\n';
    case "poll": {
      const poll = content.poll!;
      let out =
        "<section" +
        attributes +
        "><p>" +
        renderHTMLRichText(poll.question) +
        "</p>\n<ul>\n";
      for (const option of poll.options) {
        // Per-recipient option links are minted at send time and never stored
        // in a tree shared by every recipient, so a draft renders labels only.
        out += "<li>" + renderHTMLRichText(option.label) + "</li>\n";
      }
      return out + "</ul>\n</section>\n";
    }
    default:
      return "";
  }
}

function renderHTMLRichText(rich: RichText): string {
  let out = "";
  for (const run of rich.runs) {
    switch (run.kind) {
      case "text":
        out += escapeHTML(run.text);
        break;
      case "strong":
        out += "<strong>" + escapeHTML(run.text) + "</strong>";
        break;
      case "emphasis":
        out += "<em>" + escapeHTML(run.text) + "</em>";
        break;
      case "link":
        out += '<a href="' + escapeHTML(run.url) + '"';
        if (run.accessible_label !== "") {
          out += ' aria-label="' + escapeHTML(run.accessible_label) + '"';
        }
        out += ">" + escapeHTML(run.text) + "</a>";
        break;
      case "line_break":
        out += "<br>";
        break;
    }
  }
  return out;
}

function renderHTMLTime(
  attributes: string,
  value: { display_value: string; rfc3339: string; timezone: string },
): string {
  return (
    "<p" +
    attributes +
    '><time datetime="' +
    escapeHTML(value.rfc3339) +
    '" data-timezone="' +
    escapeHTML(value.timezone) +
    '">' +
    escapeHTML(value.display_value) +
    "</time></p>\n"
  );
}

function renderInlineTime(value: {
  display_value: string;
  rfc3339: string;
  timezone: string;
}): string {
  return (
    '<time datetime="' +
    escapeHTML(value.rfc3339) +
    '" data-timezone="' +
    escapeHTML(value.timezone) +
    '">' +
    escapeHTML(value.display_value) +
    "</time>"
  );
}

// ---------------------------------------------------------------------------
// Plain-text projection — render.go
// ---------------------------------------------------------------------------

function renderText(nodes: ResolvedNode[]): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    const block = renderTextNode(node);
    if (goTrimSpace(block) !== "") blocks.push(goTrimSpace(block));
  }
  return blocks.join("\n\n") + "\n";
}

function renderTextNode(resolved: ResolvedNode): string {
  const { node, content } = resolved;
  switch (node.type) {
    case "heading":
      return renderTextRichText(content.heading!.text);
    case "paragraph":
      return renderTextRichText(content.paragraph!.text);
    case "list":
      return content.list!.items
        .map((item, index) => {
          const prefix = content.list!.ordered ? `${index + 1}. ` : "- ";
          return prefix + renderTextRichText(item);
        })
        .join("\n");
    case "answer":
      return (
        renderTextRichText(content.answer!.question) +
        "\n" +
        renderTextRichText(content.answer!.answer)
      );
    case "legal":
      return renderTextRichText(content.legal!.text);
    case "action":
      if (node.role === "primary_action") {
        return (
          PRIMARY_ACTION_MARKER +
          " " +
          content.action!.label +
          ": " +
          content.action!.canonical_url
        );
      }
      return content.action!.label + ": " + content.action!.canonical_url;
    case "divider":
      // A divider is decoration. The plain-text part is what parsers and
      // summarisers read, and a row of dashes there is noise competing with
      // the content for a summariser's attention budget.
      return "";
    case "poll":
      return [
        renderTextRichText(content.poll!.question),
        ...content.poll!.options.map(
          (option) => "- " + renderTextRichText(option.label),
        ),
      ].join("\n");
    case "image":
      if (node.role === "decorative_image") return "";
      // Alt text alone: a synthetic "Image: " prefix spends the reader's
      // attention on a rendering detail and an extractor reads it as part of
      // the alt text.
      return content.image!.alt;
    case "datetime":
      return content.datetime!.display_value;
    case "deadline":
      return content.deadline!.display_value;
    case "money":
      return content.money!.display_value;
    case "offer": {
      const offer = content.offer!;
      const lines = [renderTextRichText(offer.description)];
      if (offer.code !== "") lines.push("Code: " + offer.code);
      if (offer.terms.runs.length !== 0) {
        lines.push("Terms: " + renderTextRichText(offer.terms));
      }
      if (offer.availability_starts) {
        lines.push("Starts: " + offer.availability_starts.display_value);
      }
      if (offer.availability_ends) {
        lines.push("Ends: " + offer.availability_ends.display_value);
      }
      return lines.join("\n");
    }
    case "location":
      return (
        content.location!.name + "\n" + formatAddress(content.location!.address)
      );
    case "product": {
      const product = content.product!;
      let line = product.name;
      if (product.sku !== "") line += " (SKU: " + product.sku + ")";
      if (product.canonical_url !== "") line += "\n" + product.canonical_url;
      return line;
    }
    case "fact":
      return content.fact!.label + ": " + content.fact!.value;
    case "personalization":
      if (content.personalization!.label !== "") {
        return (
          content.personalization!.label +
          ": " +
          content.personalization!.slot.fallback
        );
      }
      return content.personalization!.slot.fallback;
    default:
      return "";
  }
}

function renderTextRichText(rich: RichText): string {
  let out = "";
  for (const run of rich.runs) {
    switch (run.kind) {
      case "text":
      case "strong":
      case "emphasis":
        out += run.text;
        break;
      case "link":
        // "link text (https://url)" — angle brackets get auto-linkified by
        // some clients and fold-parsed by others, so the URL a reader sees and
        // the URL a parser extracts could differ. Parentheses are inert.
        out += run.text;
        if (run.url !== run.text) out += " (" + run.url + ")";
        break;
      case "line_break":
        out += "\n";
        break;
    }
  }
  return out;
}

function formatAddress(address: PostalAddress): string {
  return [
    address.street_address,
    address.address_locality,
    address.address_region,
    address.postal_code,
    address.address_country,
  ]
    .map((value) => goTrimSpace(value))
    .filter((value) => value !== "")
    .join(", ");
}
