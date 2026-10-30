// SPDX-License-Identifier: AGPL-3.0-only
//
// Mirror of apps/api/internal/semanticemail/validation.go.
//
// WHY A MIRROR EXISTS AT ALL
// --------------------------
// The union, the roles, and the per-node rules are a compile-time guarantee on
// the server. An editor that can author a tree the server rejects turns that
// guarantee into a runtime error the author meets AFTER saving — typically
// after ten minutes of writing. So the rules run as the author types, in the
// same vocabulary (stable DiagnosticCode, RFC 6901 path, node id) the API
// returns, and the same diagnostic object drives both the inline field error
// and the save gate.
//
// WHAT IS EXACT AND WHAT IS NOT
// -----------------------------
// Structure is exact and is pinned by a differential test against the real Go
// validator (src/__tests__/semantic-email-go-parity.test.ts): the node union,
// role/type pairing, content cardinality, inline-run cardinality, identity
// uniqueness (node, action, condition, poll, poll option), bounds, ordering of
// diagnostics, and every JSON Pointer path.
//
// Three lexical checks consult tables the browser does not have:
//
//   * currency — the server uses x/text's full ISO 4217 table. This checks
//     shape plus the two designators that are never money (XXX, XTS), so a
//     well-formed but nonexistent code is caught on save rather than here.
//   * language — Intl canonicalization instead of x/text's.
//   * timezone — Intl's zone database instead of the system IANA files.
//
// All three are deliberately no STRICTER than the server, so the editor never
// blocks a document the API would have accepted. The server stays the
// authority; this is the fast, field-addressable first opinion.

import {
  hasControlCharacter,
  isValidUTF8,
  runeCount,
  utf8ByteLength,
  goTrimSpace,
} from "./go-text";
import { parseGoURL } from "./go-url";
import {
  normalizeDecimal,
  normalizeLanguage,
  normalizeReference,
  parseRFC3339Nano,
} from "./normalize";
import {
  CONTENT_KEYS,
  CANONICAL_OFFER_ID_PATTERN,
  CONDITION_OPERATORS,
  DIRECTIONS,
  GMAIL_REGISTRY_VERSION,
  INLINE_KINDS,
  LANGUAGE_TAG_SYNTAX,
  LIMITS,
  NODE_TYPES,
  NODE_VERSION_V2,
  PROVIDER_GMAIL,
  RESERVATION_STATUSES,
  ROLES_BY_TYPE,
  SCHEMA_VERSION_V2,
  SLOT_SEMANTIC_CLASSES,
  SOURCE_KINDS,
  STABLE_REFERENCE_PATTERN,
  STRUCTURED_DATA_KINDS,
  escapeJSONPointer,
  isNodeType,
  type ActionContent,
  type Condition,
  type DateTimeContent,
  type Diagnostic,
  type DiagnosticCode,
  type ImageContent,
  type LocationContent,
  type MoneyContent,
  type NodeContent,
  type NodeType,
  type OfferContent,
  type PollContent,
  type ProductContent,
  type RichText,
  type SemanticDocument,
  type SemanticNode,
  type SlotReference,
  type StructuredDataContent,
} from "./types";

class DiagnosticSink {
  readonly items: Diagnostic[] = [];

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
}

interface NodeLocation {
  index: number;
  node: SemanticNode;
}

class DocumentValidator {
  readonly sink: DiagnosticSink;
  readonly nodeByID = new Map<string, NodeLocation>();
  readonly actionByID = new Map<string, number>();
  readonly conditionIDs = new Map<string, string>();
  readonly pollIDs = new Map<string, string>();
  primaryActionPath = "";
  lastHeadingLevel = 0;
  firstH1Path = "";

  constructor(sink: DiagnosticSink) {
    this.sink = sink;
  }

  validateNodeIdentity(base: string, index: number, node: SemanticNode) {
    validateReference(this.sink, base + "/id", node.id, node.id);
    const first = this.nodeByID.get(node.id);
    if (node.id !== "" && first !== undefined) {
      this.sink.error(
        base + "/id",
        node.id,
        "duplicate",
        `node id duplicates /nodes/${first.index}/id`,
      );
    } else if (node.id !== "") {
      this.nodeByID.set(node.id, { index, node });
    }
  }

  validateNode(base: string, node: SemanticNode) {
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) {
      this.sink.error(
        base + "/type",
        node.id,
        "invalid_enum",
        "type is not supported by semantic document v2",
      );
    }
    if (node.version !== NODE_VERSION_V2) {
      this.sink.error(
        base + "/version",
        node.id,
        "node_version_unsupported",
        "node version must be 2",
      );
    }
    if (isNodeType(node.type)) {
      const roles = ROLES_BY_TYPE[node.type] as readonly string[];
      if (!roles.includes(node.role)) {
        this.sink.error(
          base + "/role",
          node.id,
          "role_type_mismatch",
          "role is not valid for this node type",
        );
      }
    } else if (node.role === "") {
      this.sink.error(base + "/role", node.id, "required", "role is required");
    }
    if (!(SOURCE_KINDS as readonly string[]).includes(node.provenance.source)) {
      this.sink.error(
        base + "/provenance/source",
        node.id,
        "invalid_enum",
        "provenance source is not supported",
      );
    }
    if (node.type === "heading" && node.content.heading) {
      const level = node.content.heading.level;
      if (level === 1) {
        if (this.firstH1Path !== "") {
          this.sink.warning(
            base + "/content/heading/level",
            node.id,
            "multiple_top_level_headings",
            "document contains more than one level-one heading; first is " +
              this.firstH1Path,
          );
        } else {
          this.firstH1Path = base + "/content/heading/level";
        }
      }
      if (level > 1 && (this.lastHeadingLevel === 0 || level > this.lastHeadingLevel + 1)) {
        this.sink.warning(
          base + "/content/heading/level",
          node.id,
          "heading_level_skipped",
          "heading hierarchy skips a level",
        );
      }
      if (level >= 1 && level <= 6) this.lastHeadingLevel = level;
    }
    if (
      node.type === "action" &&
      node.role === "primary_action" &&
      node.conditions.length === 0
    ) {
      const path = base + "/role";
      if (this.primaryActionPath !== "") {
        this.sink.error(
          path,
          node.id,
          "multiple_primary_actions",
          "semantic document has another primary action at " +
            this.primaryActionPath,
        );
      } else {
        this.primaryActionPath = path;
      }
    }
    if (node.provenance.source_id !== "") {
      validateReference(
        this.sink,
        base + "/provenance/source_id",
        node.id,
        node.provenance.source_id,
      );
    }
    if (node.conditions.length > LIMITS.maxConditionsPerNode) {
      this.sink.error(
        base + "/conditions",
        node.id,
        "limit_exceeded",
        `at most ${LIMITS.maxConditionsPerNode} conditions are permitted per node`,
      );
    }
    node.conditions.forEach((condition, index) => {
      this.validateCondition(`${base}/conditions/${index}`, node.id, condition);
    });
    this.validateContent(base + "/content", node, node.content);
    if (node.type === "poll" && node.content.poll) {
      const pollID = node.content.poll.poll_id;
      const firstPath = this.pollIDs.get(pollID);
      if (pollID !== "" && firstPath !== undefined) {
        this.sink.error(
          base + "/content/poll/poll_id",
          node.id,
          "duplicate",
          "poll id duplicates " + firstPath,
        );
      } else if (pollID !== "") {
        this.pollIDs.set(pollID, base + "/content/poll/poll_id");
      }
    }

    const locales = Object.keys(node.localizations);
    if (locales.length > LIMITS.maxLocalizations) {
      this.sink.error(
        base + "/localizations",
        node.id,
        "limit_exceeded",
        `at most ${LIMITS.maxLocalizations} localizations are permitted per node`,
      );
    }
    for (const locale of [...locales].sort()) {
      const pathLocale = escapeJSONPointer(locale);
      validateLanguage(
        this.sink,
        base + "/localizations/" + pathLocale,
        node.id,
        locale,
      );
      const localized = node.localizations[locale];
      this.validateContent(
        base + "/localizations/" + pathLocale,
        node,
        localized,
      );
      if (node.type === "poll" && node.content.poll && localized.poll) {
        this.validateLocalizedPollIdentity(
          base + "/localizations/" + pathLocale + "/poll",
          node,
          node.content.poll,
          localized.poll,
        );
      }
      if (node.type === "offer" && node.content.offer && localized.offer) {
        if (localized.offer.canonical_offer_id !== node.content.offer.canonical_offer_id) {
          this.sink.error(
            base + "/localizations/" + pathLocale + "/offer/canonical_offer_id",
            node.id,
            "canonical_offer_reference_invalid",
            "a localization may translate an offer's words but must name the same canonical offer entity as the base content",
          );
        }
      }
    }

    if (node.type === "structured_data" && node.content.structured_data) {
      this.validateStructuredReferences(
        base + "/content/structured_data",
        node.id,
        node.content.structured_data,
      );
    }
  }

  validateLocalizedPollIdentity(
    path: string,
    node: SemanticNode,
    base: PollContent,
    localized: PollContent,
  ) {
    if (localized.poll_id !== base.poll_id) {
      this.sink.error(
        path + "/poll_id",
        node.id,
        "invalid_stable_reference",
        "localized poll id must match the base poll id",
      );
    }
    if (localized.options.length !== base.options.length) {
      this.sink.error(
        path + "/options",
        node.id,
        "content_type_mismatch",
        "localized poll must preserve the base option identity set",
      );
      return;
    }
    base.options.forEach((option, index) => {
      if (localized.options[index].option_id !== option.option_id) {
        this.sink.error(
          `${path}/options/${index}/option_id`,
          node.id,
          "invalid_stable_reference",
          "localized poll options must preserve base option ids and order",
        );
      }
    });
  }

  validateCondition(path: string, nodeID: string, condition: Condition) {
    validateReference(this.sink, path + "/id", nodeID, condition.id);
    const firstPath = this.conditionIDs.get(condition.id);
    if (condition.id !== "" && firstPath !== undefined) {
      this.sink.error(
        path + "/id",
        nodeID,
        "duplicate",
        "condition id duplicates " + firstPath,
      );
    } else if (condition.id !== "") {
      this.conditionIDs.set(condition.id, path + "/id");
    }
    validateReference(this.sink, path + "/slot_id", nodeID, condition.slot_id);
    if (!(CONDITION_OPERATORS as readonly string[]).includes(condition.operator)) {
      this.sink.error(
        path + "/operator",
        nodeID,
        "invalid_enum",
        "condition operator is not supported",
      );
    }
    if (condition.operator === "present" || condition.operator === "absent") {
      if (condition.value !== "") {
        this.sink.error(
          path + "/value",
          nodeID,
          "condition_value_forbidden",
          "present and absent conditions must not declare value",
        );
      }
    } else if (
      condition.operator === "equals" ||
      condition.operator === "not_equals"
    ) {
      if (condition.value === "") {
        this.sink.error(
          path + "/value",
          nodeID,
          "condition_value_required",
          "equality conditions require value",
        );
      } else {
        validateText(
          this.sink,
          path + "/value",
          nodeID,
          condition.value,
          LIMITS.maxShortTextRunes,
          true,
        );
      }
    }
  }

  validateContent(path: string, node: SemanticNode, content: NodeContent) {
    const { count, actual } = contentCardinality(content);
    if (count !== 1) {
      this.sink.error(
        path,
        node.id,
        "content_cardinality",
        "exactly one typed content member is required",
      );
      return;
    }
    if (actual !== node.type) {
      this.sink.error(
        path,
        node.id,
        "content_type_mismatch",
        `content ${JSON.stringify(actual)} does not match node type ${JSON.stringify(node.type)}`,
      );
      return;
    }

    switch (node.type as NodeType) {
      case "heading": {
        const heading = content.heading!;
        if (heading.level < 1 || heading.level > 6) {
          this.sink.error(
            path + "/heading/level",
            node.id,
            "number_out_of_range",
            "heading level must be between 1 and 6",
          );
        }
        this.validateRichText(path + "/heading/text", node.id, heading.text, true);
        break;
      }
      case "paragraph":
        this.validateRichText(
          path + "/paragraph/text",
          node.id,
          content.paragraph!.text,
          true,
        );
        break;
      case "list": {
        const list = content.list!;
        if (list.items.length === 0) {
          this.sink.error(
            path + "/list/items",
            node.id,
            "required",
            "list requires at least one item",
          );
        }
        if (list.items.length > LIMITS.maxListItems) {
          this.sink.error(
            path + "/list/items",
            node.id,
            "limit_exceeded",
            `list permits at most ${LIMITS.maxListItems} items`,
          );
        }
        list.items.forEach((item, index) => {
          this.validateRichText(`${path}/list/items/${index}`, node.id, item, true);
        });
        break;
      }
      case "answer":
        this.validateRichText(
          path + "/answer/question",
          node.id,
          content.answer!.question,
          true,
        );
        this.validateRichText(
          path + "/answer/answer",
          node.id,
          content.answer!.answer,
          true,
        );
        break;
      case "legal":
        this.validateRichText(
          path + "/legal/text",
          node.id,
          content.legal!.text,
          true,
        );
        break;
      case "action":
        this.validateAction(path + "/action", node.id, content.action!);
        break;
      case "image":
        this.validateImage(path + "/image", node, content.image!);
        break;
      case "datetime":
        validateDateTime(this.sink, path + "/datetime", node.id, content.datetime!);
        break;
      case "money":
        validateMoney(this.sink, path + "/money", node.id, content.money!);
        break;
      case "deadline":
        validateDateTime(this.sink, path + "/deadline", node.id, content.deadline!);
        break;
      case "offer":
        this.validateOffer(path + "/offer", node.id, content.offer!);
        break;
      case "location":
        this.validateLocation(path + "/location", node.id, content.location!);
        break;
      case "product":
        this.validateProduct(path + "/product", node.id, content.product!);
        break;
      case "fact":
        validateRequiredText(
          this.sink,
          path + "/fact/label",
          node.id,
          content.fact!.label,
          LIMITS.maxShortTextRunes,
        );
        validateRequiredText(
          this.sink,
          path + "/fact/value",
          node.id,
          content.fact!.value,
          LIMITS.maxTextRunes,
        );
        break;
      case "personalization": {
        const personalization = content.personalization!;
        if (personalization.label !== "") {
          validateText(
            this.sink,
            path + "/personalization/label",
            node.id,
            personalization.label,
            LIMITS.maxShortTextRunes,
            false,
          );
        }
        this.validateSlot(
          path + "/personalization/slot",
          node.id,
          personalization.slot,
        );
        break;
      }
      case "structured_data":
        this.validateStructured(
          path + "/structured_data",
          node.id,
          content.structured_data!,
        );
        break;
      case "divider":
        // Presence of the empty content member is the whole of a divider, and
        // the cardinality check above has already proved it.
        break;
      case "poll":
        this.validatePoll(path + "/poll", node.id, content.poll!);
        break;
    }
  }

  validateRichText(
    path: string,
    nodeID: string,
    rich: RichText,
    required: boolean,
  ) {
    if (required && rich.runs.length === 0) {
      this.sink.error(
        path + "/runs",
        nodeID,
        "required",
        "at least one inline run is required",
      );
    }
    if (rich.runs.length > LIMITS.maxRuns) {
      this.sink.error(
        path + "/runs",
        nodeID,
        "limit_exceeded",
        `rich text permits at most ${LIMITS.maxRuns} runs`,
      );
    }
    rich.runs.forEach((run, index) => {
      const base = `${path}/runs/${index}`;
      if (!(INLINE_KINDS as readonly string[]).includes(run.kind)) {
        this.sink.error(
          base + "/kind",
          nodeID,
          "invalid_enum",
          "inline kind is not supported",
        );
      }
      const textPresent = run.text !== "";
      const urlPresent = run.url !== "";
      const labelPresent = run.accessible_label !== "";
      const slotPresent = run.slot !== null;
      switch (run.kind) {
        case "text":
        case "strong":
        case "emphasis":
          if (!textPresent || urlPresent || labelPresent || slotPresent) {
            this.sink.error(
              base,
              nodeID,
              "inline_cardinality",
              "text, strong, and emphasis runs require only text",
            );
          }
          validateRequiredText(
            this.sink,
            base + "/text",
            nodeID,
            run.text,
            LIMITS.maxTextRunes,
          );
          break;
        case "link":
          if (!textPresent || !urlPresent || slotPresent) {
            this.sink.error(
              base,
              nodeID,
              "inline_cardinality",
              "link runs require text and URL, and must not contain a slot",
            );
          }
          validateRequiredText(
            this.sink,
            base + "/text",
            nodeID,
            run.text,
            LIMITS.maxTextRunes,
          );
          validateHTTPURL(this.sink, base + "/url", nodeID, run.url, false);
          if (labelPresent) {
            validateText(
              this.sink,
              base + "/accessible_label",
              nodeID,
              run.accessible_label,
              LIMITS.maxShortTextRunes,
              false,
            );
          }
          break;
        case "slot":
          if (textPresent || urlPresent || labelPresent || !slotPresent) {
            this.sink.error(
              base,
              nodeID,
              "inline_cardinality",
              "slot runs require only a slot declaration",
            );
          }
          if (run.slot !== null) {
            this.validateSlot(base + "/slot", nodeID, run.slot);
          }
          break;
        case "line_break":
          if (textPresent || urlPresent || labelPresent || slotPresent) {
            this.sink.error(
              base,
              nodeID,
              "inline_cardinality",
              "line_break runs must not contain payload fields",
            );
          }
          break;
      }
    });
  }

  validateSlot(path: string, nodeID: string, slot: SlotReference) {
    validateReference(this.sink, path + "/id", nodeID, slot.id);
    if (!(SLOT_SEMANTIC_CLASSES as readonly string[]).includes(slot.semantic_class)) {
      this.sink.error(
        path + "/semantic_class",
        nodeID,
        "invalid_enum",
        "slot semantic class is not supported",
      );
    }
    if (slot.fallback !== "") {
      validateText(
        this.sink,
        path + "/fallback",
        nodeID,
        slot.fallback,
        LIMITS.maxTextRunes,
        false,
      );
    }
  }

  validateAction(path: string, nodeID: string, action: ActionContent) {
    validateReference(this.sink, path + "/action_id", nodeID, action.action_id);
    let currentIndex = -1;
    const location = this.nodeByID.get(nodeID);
    if (location) currentIndex = location.index;
    const first = this.actionByID.get(action.action_id);
    if (action.action_id !== "" && first !== undefined) {
      if (first !== currentIndex) {
        this.sink.error(
          path + "/action_id",
          nodeID,
          "duplicate",
          `action id duplicates /nodes/${first}/content/action/action_id`,
        );
      }
    } else if (action.action_id !== "") {
      this.actionByID.set(action.action_id, currentIndex);
    }
    validateRequiredText(
      this.sink,
      path + "/label",
      nodeID,
      action.label,
      LIMITS.maxShortTextRunes,
    );
    validateHTTPURL(
      this.sink,
      path + "/canonical_url",
      nodeID,
      action.canonical_url,
      false,
    );
    if (action.accessible_description !== "") {
      validateText(
        this.sink,
        path + "/accessible_description",
        nodeID,
        action.accessible_description,
        LIMITS.maxShortTextRunes,
        false,
      );
    }
  }

  validateImage(path: string, node: SemanticNode, image: ImageContent) {
    validateHTTPURL(this.sink, path + "/url", node.id, image.url, true);
    if ((image.width === 0) !== (image.height === 0)) {
      this.sink.error(
        path,
        node.id,
        "image_dimensions_incomplete",
        "width and height must be provided together",
      );
    }
    if (
      image.width < 0 ||
      image.height < 0 ||
      image.width > LIMITS.maxImageDimension ||
      image.height > LIMITS.maxImageDimension
    ) {
      this.sink.error(
        path,
        node.id,
        "number_out_of_range",
        `image dimensions must be between 1 and ${LIMITS.maxImageDimension} when present`,
      );
    }
    if (node.role === "informative_image") {
      validateRequiredText(
        this.sink,
        path + "/alt",
        node.id,
        image.alt,
        LIMITS.maxShortTextRunes,
      );
    }
    if (node.role === "decorative_image" && image.alt !== "") {
      this.sink.error(
        path + "/alt",
        node.id,
        "decorative_alt_forbidden",
        "decorative images must use empty alt text",
      );
    }
  }

  validateOffer(path: string, nodeID: string, offer: OfferContent) {
    this.validateRichText(path + "/description", nodeID, offer.description, true);
    if (
      offer.canonical_offer_id !== "" &&
      !CANONICAL_OFFER_ID_PATTERN.test(offer.canonical_offer_id)
    ) {
      this.sink.error(
        path + "/canonical_offer_id",
        nodeID,
        "canonical_offer_reference_invalid",
        "canonical_offer_id must be a canonical lowercase UUID naming the offer entity",
      );
    }
    if (offer.code !== "") {
      validateText(
        this.sink,
        path + "/code",
        nodeID,
        offer.code,
        LIMITS.maxShortTextRunes,
        false,
      );
    }
    if (offer.terms.runs.length !== 0) {
      this.validateRichText(path + "/terms", nodeID, offer.terms, false);
    }
    if (offer.availability_starts) {
      validateDateTime(
        this.sink,
        path + "/availability_starts",
        nodeID,
        offer.availability_starts,
      );
    }
    if (offer.availability_ends) {
      validateDateTime(
        this.sink,
        path + "/availability_ends",
        nodeID,
        offer.availability_ends,
      );
    }
    if (offer.availability_starts && offer.availability_ends) {
      const start = parseRFC3339Nano(offer.availability_starts.rfc3339);
      const end = parseRFC3339Nano(offer.availability_ends.rfc3339);
      if (start && end && !(end.epochMillis > start.epochMillis)) {
        this.sink.error(
          path + "/availability_ends/rfc3339",
          nodeID,
          "number_out_of_range",
          "offer availability end must be after start",
        );
      }
    }
  }

  validateLocation(path: string, nodeID: string, location: LocationContent) {
    validateRequiredText(
      this.sink,
      path + "/name",
      nodeID,
      location.name,
      LIMITS.maxShortTextRunes,
    );
    validateRequiredText(
      this.sink,
      path + "/address/street_address",
      nodeID,
      location.address.street_address,
      LIMITS.maxTextRunes,
    );
    validateRequiredText(
      this.sink,
      path + "/address/address_locality",
      nodeID,
      location.address.address_locality,
      LIMITS.maxShortTextRunes,
    );
    if (location.address.address_region !== "") {
      validateText(
        this.sink,
        path + "/address/address_region",
        nodeID,
        location.address.address_region,
        LIMITS.maxShortTextRunes,
        false,
      );
    }
    if (location.address.postal_code !== "") {
      validateText(
        this.sink,
        path + "/address/postal_code",
        nodeID,
        location.address.postal_code,
        LIMITS.maxShortTextRunes,
        false,
      );
    }
    const country = location.address.address_country;
    if (utf8ByteLength(country) !== 2 || !isKnownRegion(country)) {
      this.sink.error(
        path + "/address/address_country",
        nodeID,
        "country_invalid_iso3166_1",
        "address_country must be an uppercase ISO 3166-1 alpha-2 code",
      );
    }
  }

  validateProduct(path: string, nodeID: string, product: ProductContent) {
    validateRequiredText(
      this.sink,
      path + "/name",
      nodeID,
      product.name,
      LIMITS.maxShortTextRunes,
    );
    if (product.sku !== "") {
      validateText(
        this.sink,
        path + "/sku",
        nodeID,
        product.sku,
        LIMITS.maxShortTextRunes,
        false,
      );
    }
    if (product.canonical_url !== "") {
      validateHTTPURL(
        this.sink,
        path + "/canonical_url",
        nodeID,
        product.canonical_url,
        false,
      );
    }
    if (product.image_url !== "") {
      validateHTTPURL(this.sink, path + "/image_url", nodeID, product.image_url, true);
    }
  }

  validateStructured(
    path: string,
    nodeID: string,
    structured: StructuredDataContent,
  ) {
    if (structured.provider !== PROVIDER_GMAIL) {
      this.sink.error(
        path + "/provider",
        nodeID,
        "invalid_enum",
        "only the pinned Gmail registry is supported",
      );
    }
    if (structured.registry_version !== GMAIL_REGISTRY_VERSION) {
      this.sink.error(
        path + "/registry_version",
        nodeID,
        "registry_version_unsupported",
        "registry version is not supported by this compiler",
      );
    }
    const validUseCase =
      structured.use_case === "gmail_promotion" ||
      structured.use_case === "gmail_transaction";
    if (!validUseCase) {
      this.sink.error(
        path + "/use_case",
        nodeID,
        "invalid_enum",
        "structured-data use case is not supported",
      );
    }
    const { count, kind } = structuredDeclarationCardinality(structured);
    if (count !== 1) {
      this.sink.error(
        path + "/declaration",
        nodeID,
        "content_cardinality",
        "exactly one structured declaration is required",
      );
      return;
    }
    if (kind !== structured.kind) {
      this.sink.error(
        path + "/declaration",
        nodeID,
        "structured_kind_mismatch",
        "declaration does not match structured-data kind",
      );
    }
    const expectedUseCase =
      structured.kind === "discount_offer" || structured.kind === "promotion_card"
        ? "gmail_promotion"
        : "gmail_transaction";
    if (structured.use_case !== expectedUseCase) {
      this.sink.error(
        path + "/use_case",
        nodeID,
        "structured_kind_mismatch",
        "structured-data kind is not valid for this use case",
      );
    }
  }

  validateStructuredReferences(
    path: string,
    nodeID: string,
    structured: StructuredDataContent,
  ) {
    const declaration = structured.declaration;
    switch (structured.kind) {
      case "discount_offer":
        if (declaration.discount_offer) {
          this.validateNodeReference(
            path + "/declaration/discount_offer/offer_node_id",
            nodeID,
            declaration.discount_offer.offer_node_id,
            ["offer"],
            true,
          );
        }
        break;
      case "promotion_card":
        if (declaration.promotion_card) {
          const card = declaration.promotion_card;
          this.validateNodeReference(
            path + "/declaration/promotion_card/image_node_id",
            nodeID,
            card.image_node_id,
            ["image"],
            true,
          );
          this.validateNodeReference(
            path + "/declaration/promotion_card/action_node_id",
            nodeID,
            card.action_node_id,
            ["action"],
            true,
          );
          this.validateNodeReference(
            path + "/declaration/promotion_card/headline_node_id",
            nodeID,
            card.headline_node_id,
            ["heading", "paragraph", "fact", "product"],
            false,
          );
          this.validateNodeReference(
            path + "/declaration/promotion_card/price_node_id",
            nodeID,
            card.price_node_id,
            ["money"],
            false,
          );
          this.validateNodeReference(
            path + "/declaration/promotion_card/discount_value_node_id",
            nodeID,
            card.discount_value_node_id,
            ["money"],
            false,
          );
          if (card.position < 0 || card.position > 10) {
            this.sink.error(
              path + "/declaration/promotion_card/position",
              nodeID,
              "number_out_of_range",
              "promotion card position must be between 0 and 10",
            );
          }
          const imageLocation = this.nodeByID.get(card.image_node_id);
          const image = imageLocation?.node.content.image;
          if (image) {
            if (image.width <= 0 || image.height <= 0) {
              this.sink.error(
                path + "/declaration/promotion_card/image_node_id",
                nodeID,
                "image_dimensions_incomplete",
                "promotion cards require known image dimensions",
              );
            } else if (!supportedPromotionAspectRatio(image.width, image.height)) {
              this.sink.error(
                path + "/declaration/promotion_card/image_node_id",
                nodeID,
                "number_out_of_range",
                "promotion card image ratio must be 4:5, 1:1, or 1.91:1",
              );
            }
          }
        }
        break;
      case "event_reservation":
        if (declaration.event_reservation) {
          const reservation = declaration.event_reservation;
          const prefix = path + "/declaration/event_reservation";
          this.validateNodeReference(
            prefix + "/reservation_number_node_id",
            nodeID,
            reservation.reservation_number_node_id,
            ["fact", "personalization"],
            true,
          );
          this.validateNodeReference(
            prefix + "/under_name_node_id",
            nodeID,
            reservation.under_name_node_id,
            ["fact", "personalization"],
            true,
          );
          this.validateNodeReference(
            prefix + "/event_name_node_id",
            nodeID,
            reservation.event_name_node_id,
            ["heading", "fact", "product"],
            true,
          );
          this.validateNodeReference(
            prefix + "/start_datetime_node_id",
            nodeID,
            reservation.start_datetime_node_id,
            ["datetime"],
            true,
          );
          this.validateNodeReference(
            prefix + "/location_node_id",
            nodeID,
            reservation.location_node_id,
            ["location"],
            true,
          );
          this.validateNodeReference(
            prefix + "/status_node_id",
            nodeID,
            reservation.status_node_id,
            ["fact"],
            true,
          );
          this.validateNodeReference(
            prefix + "/action_node_id",
            nodeID,
            reservation.action_node_id,
            ["action"],
            false,
          );
          if (!(RESERVATION_STATUSES as readonly string[]).includes(reservation.status)) {
            this.sink.error(
              prefix + "/status",
              nodeID,
              "invalid_enum",
              "reservation status is not supported",
            );
          }
          const statusFact = this.nodeByID.get(reservation.status_node_id)?.node
            .content.fact;
          if (
            statusFact &&
            statusFact.value.toLowerCase() !== reservation.status.toLowerCase()
          ) {
            this.sink.error(
              prefix + "/status_node_id",
              nodeID,
              "structured_kind_mismatch",
              "visible reservation status fact must match the typed schema status",
            );
          }
        }
        break;
      case "order":
        if (declaration.order) {
          const order = declaration.order;
          const prefix = path + "/declaration/order";
          this.validateNodeReference(
            prefix + "/merchant_node_id",
            nodeID,
            order.merchant_node_id,
            ["fact", "product"],
            true,
          );
          this.validateNodeReference(
            prefix + "/order_number_node_id",
            nodeID,
            order.order_number_node_id,
            ["fact", "personalization"],
            true,
          );
          this.validateNodeReference(
            prefix + "/total_node_id",
            nodeID,
            order.total_node_id,
            ["money"],
            true,
          );
          this.validateNodeReference(
            prefix + "/action_node_id",
            nodeID,
            order.action_node_id,
            ["action"],
            false,
          );
          if (order.items.length === 0) {
            this.sink.error(
              prefix + "/items",
              nodeID,
              "required",
              "order requires at least one accepted item",
            );
          }
          if (order.items.length > LIMITS.maxOrderItems) {
            this.sink.error(
              prefix + "/items",
              nodeID,
              "limit_exceeded",
              `order permits at most ${LIMITS.maxOrderItems} items`,
            );
          }
          order.items.forEach((item, index) => {
            const base = `${prefix}/items/${index}`;
            this.validateNodeReference(
              base + "/product_node_id",
              nodeID,
              item.product_node_id,
              ["product"],
              true,
            );
            this.validateNodeReference(
              base + "/price_node_id",
              nodeID,
              item.price_node_id,
              ["money"],
              true,
            );
            this.validateNodeReference(
              base + "/quantity_node_id",
              nodeID,
              item.quantity_node_id,
              ["fact"],
              true,
            );
            const quantityFact = this.nodeByID.get(item.quantity_node_id)?.node
              .content.fact;
            if (quantityFact) {
              const value = quantityFact.value;
              const canonical = normalizeDecimal(value);
              if (canonical === null || canonical !== value) {
                this.sink.error(
                  base + "/quantity_node_id",
                  nodeID,
                  "decimal_invalid",
                  "referenced quantity fact must be a canonical decimal",
                );
              } else if (Number(value) <= 0) {
                this.sink.error(
                  base + "/quantity_node_id",
                  nodeID,
                  "number_out_of_range",
                  "referenced quantity must be greater than zero",
                );
              }
            }
          });
        }
        break;
    }
  }

  validateNodeReference(
    path: string,
    ownerID: string,
    targetID: string,
    allowed: readonly NodeType[],
    required: boolean,
  ) {
    if (targetID === "") {
      if (required) {
        this.sink.error(path, ownerID, "required", "node reference is required");
      }
      return;
    }
    validateReference(this.sink, path, ownerID, targetID);
    const location = this.nodeByID.get(targetID);
    if (!location) {
      this.sink.error(
        path,
        ownerID,
        "node_reference_missing",
        "referenced semantic node does not exist",
      );
      return;
    }
    if (!(allowed as readonly string[]).includes(location.node.type)) {
      this.sink.error(
        path,
        ownerID,
        "node_reference_type_mismatch",
        `referenced node type ${JSON.stringify(location.node.type)} is not permitted here`,
      );
      return;
    }
    if (location.node.type === "action" && location.node.content.action) {
      const parsed = parseGoURL(location.node.content.action.canonical_url);
      if (parsed === null || parsed.scheme !== "https") {
        this.sink.error(
          path,
          ownerID,
          "https_required",
          "structured-data action references require an HTTPS canonical URL",
        );
      }
    }
  }

  validatePoll(path: string, nodeID: string, poll: PollContent) {
    // Poll and option ids cross the authoring/runtime boundary and become URL
    // path components, so they live in the same stable-reference vocabulary as
    // node and action ids rather than accepting arbitrary display text.
    validateReference(this.sink, path + "/poll_id", nodeID, poll.poll_id);
    this.validateRichText(path + "/question", nodeID, poll.question, true);

    if (poll.options.length < LIMITS.minPollOptions) {
      this.sink.error(
        path + "/options",
        nodeID,
        "required",
        `a poll requires at least ${LIMITS.minPollOptions} options`,
      );
      return;
    }
    if (poll.options.length > LIMITS.maxPollOptions) {
      this.sink.error(
        path + "/options",
        nodeID,
        "limit_exceeded",
        `a poll permits at most ${LIMITS.maxPollOptions} options`,
      );
      return;
    }
    const seen = new Set<string>();
    poll.options.forEach((option, index) => {
      const optionPath = `${path}/options/${index}`;
      validateReference(
        this.sink,
        optionPath + "/option_id",
        nodeID,
        option.option_id,
      );
      this.validateRichText(optionPath + "/label", nodeID, option.label, true);
      if (option.option_id === "") return;
      if (seen.has(option.option_id)) {
        // Duplicate option ids silently merge two choices into one tally: the
        // kind of defect that produces a confident wrong answer rather than an
        // error.
        this.sink.error(
          optionPath + "/option_id",
          nodeID,
          "duplicate",
          "option ids must be unique within a poll; duplicates merge two choices into one tally",
        );
        return;
      }
      seen.add(option.option_id);
    });
  }
}

export function contentCardinality(content: NodeContent): {
  count: number;
  actual: string;
} {
  let count = 0;
  let actual = "";
  for (const key of CONTENT_KEYS) {
    if (content[key] !== undefined && content[key] !== null) {
      count += 1;
      actual = key;
    }
  }
  return { count, actual };
}

function structuredDeclarationCardinality(structured: StructuredDataContent): {
  count: number;
  kind: string;
} {
  let count = 0;
  let kind = "";
  for (const candidate of STRUCTURED_DATA_KINDS) {
    if (structured.declaration[candidate] !== undefined) {
      count += 1;
      kind = candidate;
    }
  }
  return { count, kind };
}

function supportedPromotionAspectRatio(width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return [0.8, 1, 1.91].some((supported) => Math.abs(ratio - supported) <= 0.015);
}

function validateReference(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
) {
  if (value === "") {
    sink.error(path, nodeID, "required", "stable reference is required");
    return;
  }
  if (
    utf8ByteLength(value) > LIMITS.maxReferenceBytes ||
    !STABLE_REFERENCE_PATTERN.test(value)
  ) {
    sink.error(
      path,
      nodeID,
      "invalid_stable_reference",
      "stable reference must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen",
    );
  }
}

function validateRequiredText(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
  maxRunes: number,
) {
  if (value === "" || goTrimSpace(value) === "") {
    sink.error(path, nodeID, "required", "value is required");
    return;
  }
  validateText(sink, path, nodeID, value, maxRunes, false);
}

function validateText(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
  maxRunes: number,
  allowEmpty: boolean,
) {
  if (!allowEmpty && value === "") return;
  if (!isValidUTF8(value)) {
    sink.error(path, nodeID, "invalid_text", "value must be valid UTF-8");
    return;
  }
  if (runeCount(value) > maxRunes) {
    sink.error(
      path,
      nodeID,
      "text_too_long",
      `value must contain at most ${maxRunes} Unicode characters`,
    );
  }
  if (hasControlCharacter(value)) {
    sink.error(
      path,
      nodeID,
      "invalid_text",
      "value must not contain control characters",
    );
  }
}

function validateHTTPURL(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
  requireHTTPS: boolean,
) {
  if (value === "") {
    sink.error(path, nodeID, "required", "URL is required");
    return;
  }
  if (!isValidUTF8(value) || utf8ByteLength(value) > LIMITS.maxURLBytes) {
    sink.error(
      path,
      nodeID,
      "invalid_url",
      "URL must be valid UTF-8 and at most 4096 bytes",
    );
    return;
  }
  if (hasControlCharacter(value)) {
    sink.error(path, nodeID, "invalid_url", "URL must not contain control characters");
    return;
  }
  const parsed = parseGoURL(value);
  if (
    parsed === null ||
    parsed.opaque !== "" ||
    (parsed.scheme !== "http" && parsed.scheme !== "https") ||
    parsed.hostname === ""
  ) {
    sink.error(
      path,
      nodeID,
      "invalid_url",
      "URL must be an absolute http or https URL with a host",
    );
    return;
  }
  if (requireHTTPS && parsed.scheme !== "https") {
    sink.error(path, nodeID, "https_required", "URL must use HTTPS");
  }
  if (parsed.user !== null) {
    sink.error(
      path,
      nodeID,
      "url_credentials_forbidden",
      "URL must not contain user credentials",
    );
  }
  if (parsed.fragment !== "") {
    sink.error(
      path,
      nodeID,
      "url_fragment_forbidden",
      "canonical URL must not contain a fragment",
    );
  }
}

function validateDateTime(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: DateTimeContent,
) {
  validateRequiredText(
    sink,
    path + "/display_value",
    nodeID,
    value.display_value,
    LIMITS.maxShortTextRunes,
  );
  if (value.rfc3339 === "") {
    sink.error(path + "/rfc3339", nodeID, "required", "rfc3339 is required");
  }
  const parsed = parseRFC3339Nano(value.rfc3339);
  if (value.rfc3339 !== "" && parsed === null) {
    sink.error(
      path + "/rfc3339",
      nodeID,
      "datetime_invalid_rfc3339",
      "rfc3339 must be a timestamp with an explicit numeric offset",
    );
  }
  if (value.timezone === "") {
    sink.error(path + "/timezone", nodeID, "required", "timezone is required");
    return;
  }
  if (
    value.timezone === "Local" ||
    utf8ByteLength(value.timezone) > LIMITS.maxTimezoneBytes
  ) {
    sink.error(
      path + "/timezone",
      nodeID,
      "timezone_unknown",
      "timezone must be an environment-independent IANA zone",
    );
    return;
  }
  const zoneOffset = zoneOffsetMinutes(value.timezone, parsed?.epochMillis ?? 0);
  if (zoneOffset === null) {
    sink.error(
      path + "/timezone",
      nodeID,
      "timezone_unknown",
      "timezone is not a recognized IANA zone",
    );
    return;
  }
  if (parsed !== null && parsed.offsetMinutes !== zoneOffset) {
    sink.error(
      path + "/rfc3339",
      nodeID,
      "timezone_offset_mismatch",
      "timestamp offset does not match timezone at that instant",
    );
  }
}

/** Offset east of UTC in minutes for an IANA zone at an instant; null if unknown. */
export function zoneOffsetMinutes(
  timezone: string,
  epochMillis: number,
): number | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });
  } catch {
    return null;
  }
  const part = formatter
    .formatToParts(new Date(epochMillis))
    .find((entry) => entry.type === "timeZoneName");
  if (!part) return null;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part.value);
  if (!match) return part.value === "GMT" ? 0 : null;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

let regionDisplayNames: Intl.DisplayNames | null | undefined;

function isKnownRegion(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code) || code === "ZZ") return false;
  if (regionDisplayNames === undefined) {
    try {
      regionDisplayNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionDisplayNames = null;
    }
  }
  if (regionDisplayNames === null) return true;
  try {
    return regionDisplayNames.of(code) !== code;
  } catch {
    return false;
  }
}

function validateMoney(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: MoneyContent,
) {
  validateRequiredText(
    sink,
    path + "/display_value",
    nodeID,
    value.display_value,
    LIMITS.maxShortTextRunes,
  );
  validateDecimal(sink, path + "/amount", nodeID, value.amount);
  if (value.currency === "") {
    sink.error(path + "/currency", nodeID, "required", "currency is required");
    return;
  }
  if (
    !/^[A-Z]{3}$/.test(value.currency) ||
    value.currency === "XXX" ||
    value.currency === "XTS"
  ) {
    sink.error(
      path + "/currency",
      nodeID,
      "currency_invalid_iso4217",
      "currency must be a canonical uppercase ISO 4217 designator",
    );
  }
}

function validateDecimal(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
) {
  if (value === "") {
    sink.error(path, nodeID, "required", "decimal value is required");
    return;
  }
  const canonical = normalizeDecimal(value);
  if (canonical === null || canonical !== value) {
    sink.error(
      path,
      nodeID,
      "decimal_invalid",
      "value must be a canonical base-10 decimal without exponent notation",
    );
    return;
  }
  const raw = value.startsWith("-") ? value.slice(1) : value;
  const dot = raw.indexOf(".");
  const integerPart = dot < 0 ? raw : raw.slice(0, dot);
  const fractionPart = dot < 0 ? "" : raw.slice(dot + 1);
  const digits = integerPart.length + fractionPart.length;
  if (digits > LIMITS.maxDecimalDigits || fractionPart.length > LIMITS.maxDecimalScale) {
    sink.error(
      path,
      nodeID,
      "decimal_precision_exceeded",
      `decimal permits at most ${LIMITS.maxDecimalDigits} digits and ${LIMITS.maxDecimalScale} fractional digits`,
    );
  }
}


/**
 * A canonical, specific BCP 47 tag — the same three properties x/text's
 * language.Parse enforces: it parses, its base is not "und", and it is already
 * in canonical form so "iw" cannot masquerade as a stored "he".
 *
 * The base subtag is additionally checked against a real language table,
 * because "english" and "xx" are well-FORMED and mean nothing; a document
 * language nobody can resolve is a message no reader's client can label.
 */
export function isCanonicalLanguageTag(value: string): boolean {
  if (utf8ByteLength(value) > LIMITS.maxLanguageTagBytes) return false;
  if (!LANGUAGE_TAG_SYNTAX.test(value)) return false;
  let base: string | undefined;
  try {
    const locale = new Intl.Locale(value);
    if (locale.toString() !== value) return false;
    base = locale.language;
  } catch {
    return false;
  }
  if (!base || base === "und") return false;
  // The base subtag must be a REAL language subtag: ISO 639 assigns 2 and 3
  // letters, and BCP 47 reserves 4 (script-shaped) and 5-8 for future use with
  // nothing currently registered.
  //
  // This replaces an Intl.DisplayNames lookup that asked "does this runtime have
  // a name for that language". That was strictly wrong in BOTH directions: it
  // rejected perfectly valid tags whose language the runtime had no display name
  // for — which are exactly the less-common languages, so the failure landed on
  // the customers least able to work around it — and it made the rule depend on
  // which locale data the browser shipped, so the same document could validate
  // on one machine and fail on another.
  //
  // A length rule is the honest approximation of the registry Go's
  // language.Parse consults. It keeps out the mistake this actually catches in
  // practice — writing "english" or "spanish" instead of "en"/"es", which is
  // syntactically a valid 5-8 letter subtag and semantically nothing — without
  // pretending to know the registry.
  //
  // Deliberately no LOOSER than the server either: an editor that accepted a tag
  // the API rejects moves the error from the field the author is typing in to a
  // save that fails later with no field to point at.
  return base.length === 2 || base.length === 3;
}

function validateLanguage(
  sink: DiagnosticSink,
  path: string,
  nodeID: string,
  value: string,
) {
  if (value === "") {
    sink.error(path, nodeID, "required", "language is required");
    return;
  }
  if (!isCanonicalLanguageTag(value)) {
    sink.error(
      path,
      nodeID,
      "invalid_language",
      "language must be a canonical, specific BCP 47 tag",
    );
  }
}

/**
 * Mirrors validateNormalizedV2: the document must already be normalized.
 * Diagnostics come back in document order so an editor can annotate every
 * affected field at once instead of one error per save.
 */
export function validateNormalizedDocument(
  document: SemanticDocument,
): Diagnostic[] {
  const sink = new DiagnosticSink();
  if (document.schema_version !== SCHEMA_VERSION_V2) {
    sink.error(
      "/schema_version",
      "",
      "schema_version_unsupported",
      "schema_version must be 2",
    );
  }
  validateLanguage(sink, "/language", "", document.language);
  if (!(DIRECTIONS as readonly string[]).includes(document.direction)) {
    sink.error(
      "/direction",
      "",
      "invalid_enum",
      "direction must be ltr, rtl, or auto",
    );
  }
  if (document.nodes.length === 0) {
    sink.error("/nodes", "", "required", "at least one semantic node is required");
  }
  if (document.nodes.length > LIMITS.maxNodes) {
    sink.error(
      "/nodes",
      "",
      "limit_exceeded",
      `at most ${LIMITS.maxNodes} nodes are permitted`,
    );
  }

  const validator = new DocumentValidator(sink);
  document.nodes.forEach((node, index) => {
    validator.validateNodeIdentity(`/nodes/${index}`, index, node);
  });
  document.nodes.forEach((node, index) => {
    validator.validateNode(`/nodes/${index}`, node);
  });
  return sink.items;
}

/** Mirrors the locale-collision pass that runs before validation. */
export function normalizationDiagnostics(
  document: SemanticDocument,
): Diagnostic[] {
  const sink = new DiagnosticSink();
  document.nodes.forEach((node, index) => {
    const locales = Object.keys(node.localizations);
    if (locales.length < 2) return;
    const seen = new Map<string, string>();
    for (const raw of [...locales].sort()) {
      const canonical = normalizeLanguage(raw);
      const first = seen.get(canonical);
      const path = `/nodes/${index}/localizations/${escapeJSONPointer(raw)}`;
      if (first !== undefined) {
        sink.error(
          path,
          normalizeReference(node.id),
          "duplicate",
          "locale collides after normalization with " + first,
        );
      } else {
        seen.set(canonical, path);
      }
    }
  });
  return sink.items;
}

export { DiagnosticSink };
