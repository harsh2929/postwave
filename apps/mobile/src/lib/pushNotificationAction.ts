/**
 * lib/pushNotificationAction.ts — reading a notification response safely.
 *
 * THE THREAT. A notification's `data` bag is attacker-influenced in the sense
 * that matters here: it is assembled server-side from records a customer can
 * edit (a subscriber's custom fields, a campaign name, a webhook payload that
 * was echoed into an event). Whatever comes out of it is then used to ROUTE the
 * app and, for approval categories, to POST a decision. So the parser reads a
 * fixed, flat, bounded set of keys and ignores everything else — a nested
 * `{customer: {entity_id: ...}}` in a legacy record must never become a command.
 *
 * Split out of lib/push.ts (NATIVE#54): the rules are pure, the module imports
 * expo-notifications for TYPES only, and the whole thing is node-testable.
 */
import type * as Notifications from "expo-notifications";

/**
 * Parsed shape of a notification response relevant to the response handler:
 * which action the user took, the event type, and the entity/decision id the
 * backend lifted to Data.entity_id. Defensive — every field is optional so a
 * malformed payload yields a harmless "default tap, no id" result rather than
 * a crash.
 */
export interface ParsedNotificationAction {
  /** Notifications.DEFAULT_ACTION_IDENTIFIER for a plain tap, else the action id. */
  actionIdentifier: string;
  eventType: string;
  entityId: string;
  /**
   * Text the OS collected for a `textInput` action — today only the mandatory
   * reject reason (GOVERNANCE#37). Unlike `entity_id` this is typed by the
   * DEVICE HOLDER rather than assembled server-side, so it is not a routing or
   * command input and is never interpolated into a path; it travels as a
   * request body field and nothing else. Absent for every other action, and for
   * a platform that returned no text.
   */
  userText: string | undefined;
}

/**
 * Longer than any identifier the backend mints, short enough that a pathological
 * value cannot be smuggled through as a route or a request path.
 */
export const MAX_PUSH_ENTITY_ID_CHARS = 256;

/**
 * parseNotificationAction — pull the action identifier, event type, and
 * entity id out of an Expo notification response. The backend sender sets
 * exactly `event_type` and optional `entity_id` at the top level. Nested
 * bodies are deliberately ignored so a legacy/arbitrary customer record can
 * never become an actionable command.
 */
export function parseNotificationAction(
  response: Notifications.NotificationResponse | null | undefined,
): ParsedNotificationAction | null {
  if (!response) return null;
  const data = response.notification?.request?.content?.data;
  if (!data || typeof data !== "object") return null;
  const top = data as Record<string, unknown>;

  const eventType = typeof top.event_type === "string" ? top.event_type : "";
  let entityId = typeof top.entity_id === "string" ? top.entity_id : "";

  if (entityId.length > MAX_PUSH_ENTITY_ID_CHARS) entityId = "";

  return {
    actionIdentifier: response.actionIdentifier,
    eventType,
    entityId,
    // exactOptionalPropertyTypes is on, so the field is `string | undefined`
    // rather than optional — a present-but-undefined key is the honest
    // representation of "the OS offered no text".
    userText:
      typeof response.userText === "string" ? response.userText : undefined,
  };
}
