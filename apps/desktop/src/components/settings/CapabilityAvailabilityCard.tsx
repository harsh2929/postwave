import { type ReactElement } from "react";

import {
  getCapabilityObservation,
  useCapabilityObservationsRevision,
} from "../../lib/capability-observations";
import type { CapabilityObservation } from "../../lib/capability-access";
import {
  capabilityForSection,
  capabilityReadinessLabel,
  type DesktopCapabilityMeta,
} from "../../lib/desktop-capabilities";
import {
  PERSISTENT_DESKTOP_SECTIONS,
  routeMetaForSection,
} from "../../lib/desktop-routes";
import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { setSection, useMe } from "../../lib/store";

function humanizeTier(tier: string | null): string {
  const key = (tier ?? "").trim();
  if (!key) return "Current plan";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function availabilityLabel(
  capability: DesktopCapabilityMeta,
  observation: CapabilityObservation | null,
): string {
  if (observation?.state === "plan-required") return "Plan required";
  if (observation?.state === "not-configured") return "Not configured";
  if (observation?.state === "partial-plan-required") {
    return "Partially available · plan required";
  }
  if (observation?.state === "partial-not-configured") {
    return "Partially available · setup required";
  }
  if (capability.entryRole) {
    const role =
      capability.entryRole === "admin" ? "Admin" : capability.entryRole;
    return `${role} role`;
  }
  if (capability.auditScope) return "Audit permission";
  return capabilityReadinessLabel(capability.readiness) ?? "Available";
}

function availabilityReason(
  capability: DesktopCapabilityMeta,
  observation: CapabilityObservation | null,
): string | null {
  if (observation?.reason) return observation.reason;
  if (capability.limitation) return capability.limitation;
  if (capability.entryRole) {
    return `Requires the ${capability.entryRole} role to enter.`;
  }
  if (capability.auditScope) return `Requires ${capability.auditScope}.`;
  return null;
}

export function CapabilityAvailabilityCard({
  planTier,
}: {
  planTier: string | null;
}): ReactElement {
  const me = useMe();
  const scope = desktopRouteIdentityScope(me?.user, me?.tenant);
  useCapabilityObservationsRevision(scope);

  const disclosed = PERSISTENT_DESKTOP_SECTIONS.flatMap((section) => {
    const meta = routeMetaForSection(section);
    const capability = capabilityForSection(section);
    const observation = getCapabilityObservation(scope, section);
    if (
      capability.readiness === "operational" &&
      !capability.entryRole &&
      !capability.auditScope &&
      (!observation || observation.state === "available")
    ) {
      return [];
    }
    return [{ section, meta, capability, observation }];
  });

  return (
    <section
      id="product-availability-disclosure"
      className="card"
      aria-labelledby="product-availability-heading"
      style={{ marginTop: 8, padding: 12 }}
    >
      <h3 id="product-availability-heading" style={{ margin: 0, fontSize: 13 }}>
        Product availability · {disclosed.length} disclosed limitation
        {disclosed.length === 1 ? "" : "s"}
      </h3>
      <p className="muted" style={{ fontSize: 12 }}>
        This is the same readiness source used by navigation, search and route
        access. {planTier ? `Current plan: ${humanizeTier(planTier)}. ` : ""}A
        plan restriction is shown only after an authoritative endpoint reports
        it; a usage limit is never guessed to be an entitlement.
      </p>
      <div style={{ display: "grid", gap: 8 }}>
        {disclosed.map(({ section, meta, capability, observation }) => {
          const label = availabilityLabel(capability, observation);
          const reason = availabilityReason(capability, observation);
          return (
            <div
              key={section}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <button
                type="button"
                className="btn btn-xs btn-ghost"
                onClick={() => setSection(section)}
              >
                {meta.title}
              </button>
              <span className="badge">{label}</span>
              {reason ? (
                <span className="muted" style={{ fontSize: 11 }}>
                  {reason}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
