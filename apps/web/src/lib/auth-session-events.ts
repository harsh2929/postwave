// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser event emitted when the authenticated transport confirms that the
 * current dashboard session is no longer usable.
 *
 * Keep this contract transport-free. The persistent dashboard shell only
 * needs the event name; importing it from api.ts would otherwise publish the
 * complete request, retry, step-up, and offline-outbox runtime on every route.
 */
export const AUTH_SESSION_EXPIRED_EVENT = "postwave:auth-session-expired";
