// SPDX-License-Identifier: MIT

/**
 * @postwave/audit-portal-react — public entry.
 *
 * Re-exports the <PostwaveAuditPortal /> component plus the type the
 * caller needs to wire postMessage events. Kept tiny on purpose: the
 * SDK is emitted as ESM plus declarations; customer apps never need to
 * compile Moosewave's TypeScript source.
 */
export {
  PostwaveAuditPortal,
  type PostwaveAuditPortalProps,
  type PortalErrorEvent,
} from "./PostwaveAuditPortal.js";

export { portalSessionOrigin, withPortalTheme } from "./session-url.js";
