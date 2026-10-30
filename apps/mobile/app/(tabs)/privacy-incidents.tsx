/**
 * Breach incidents — a read-only mobile view of recorded incident state.
 *
 * The server exposes an administrative incident register and a legacy
 * 72-hour operational target. That target is not a legal determination. The
 * jurisdiction payload intentionally contains recognition metadata plus an
 * explicit release hold; it does not calculate duties, recipients, or filing
 * deadlines.
 *
 * Mobile reads the bounded register, detail, and evidence ledger. It does not
 * create incidents or record transitions because this build has no bounded
 * operator-rationale interaction with conflict-safe draft handling. It also
 * cannot invoke the server-held sign-off, notification-evidence, packet, or
 * closure operations. Those absences are safety boundaries, not capability
 * claims.
 *
 * Every incident route requires the admin scope. Session authentication maps
 * that scope to owner/admin; API-key authentication requires an admin-scoped
 * key. The generated route-auth manifest is derived from the canonical
 * OpenAPI `x-required-scopes: [admin]` declaration.
 */
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { PrivacyIncidentsScreen } from "@/components/privacy-incidents/PrivacyIncidentsScreen";

/** A render failure is contained to this sensitive register tab. */
export { AppErrorBoundary as ErrorBoundary };

export default function PrivacyIncidents() {
  return <PrivacyIncidentsScreen />;
}
