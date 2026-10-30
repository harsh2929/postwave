/**
 * Strict, display-safe wire contract for the service-suite Helpdesk.
 *
 * This module is the ONE import every Helpdesk surface uses; the contract it
 * fronts is split by responsibility across siblings so no single file carries
 * the whole thing:
 *
 *   helpdeskTypes            the vocabulary and the shapes
 *   helpdeskContract         field-level primitives every parser is built from
 *   helpdeskConversationWire conversation rows and their page window
 *   helpdeskMessageWire      message rows, their window, the note receipt
 *   helpdeskCatalogWire      the capability catalog
 *   helpdeskDerive           what the UI derives, and the standing disclosures
 *   helpdeskNoteInput        internal-note body and idempotency-key refusals
 *
 * The re-export list below is deliberate rather than a `export *`: the
 * primitives the sibling parsers share with each other are NOT part of this
 * public surface, and listing what is keeps that boundary visible.
 */
export {
  HELPDESK_CONVERSATION_STATUSES,
  HelpdeskContractError,
  isHelpdeskConversationStatus,
} from "@/lib/helpdeskTypes";
export type {
  HelpdeskCatalog,
  HelpdeskConversation,
  HelpdeskConversationPage,
  HelpdeskConversationStatus,
  HelpdeskMessage,
  HelpdeskMessageDeliveryStatus,
  HelpdeskMessageDirection,
  HelpdeskMessagePage,
  HelpdeskMessageRecordKind,
  HelpdeskPageInfo,
} from "@/lib/helpdeskTypes";

export {
  helpdeskStrongEntityTag,
  helpdeskUtf8Bytes,
  normalizeHelpdeskId,
  normalizeHelpdeskOpaqueCursor,
} from "@/lib/helpdeskContract";

export {
  mergeHelpdeskConversationPages,
  normalizeServiceConversation,
  normalizeServiceConversationPage,
  normalizeServiceConversations,
} from "@/lib/helpdeskConversationWire";

export {
  mergeHelpdeskMessagePages,
  normalizeServiceInternalNote,
  normalizeServiceMessagePage,
  normalizeServiceMessages,
} from "@/lib/helpdeskMessageWire";

export { normalizeServiceCatalog } from "@/lib/helpdeskCatalogWire";

export {
  HELPDESK_DELIVERY_NOTE,
  HELPDESK_INTERNAL_NOTE_LIFECYCLE_NOTE,
  HELPDESK_SCOPE_NOTE,
  activeConversationCount,
  conversationSortKey,
  conversationSubtitle,
  conversationTitle,
  helpdeskAdminAccess,
  helpdeskClaimAction,
  helpdeskClaimLabel,
  humanizeToken,
  statusTone,
} from "@/lib/helpdeskDerive";
export type {
  HelpdeskAdminAccess,
  HelpdeskClaimAction,
  HelpdeskStatusTone,
} from "@/lib/helpdeskDerive";

export {
  HELPDESK_INTERNAL_NOTE_MAX_BYTES,
  normalizeHelpdeskIdempotencyKey,
  normalizeHelpdeskInternalNoteBody,
} from "@/lib/helpdeskNoteInput";
