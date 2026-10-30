import {
  capabilityReadinessLabel,
  capabilityForSection,
  type DesktopCapabilityReadiness,
} from "./desktop-capabilities";
import type { OnlineStatus } from "./online-manager";
import type { Role, RoleStatus, Section } from "./store";

export type CapabilityObservationState =
  | "available"
  | "not-configured"
  | "plan-required"
  | "partial-not-configured"
  | "partial-plan-required";

export interface CapabilityObservation {
  state: CapabilityObservationState;
  reason: string;
  observedAt: number;
}

export interface CapabilityAccessEnvironment {
  role: Role | null;
  roleStatus: RoleStatus;
  online: OnlineStatus;
  audit: {
    loading: boolean;
    isAdmin: boolean;
    scopes: ReadonlySet<string>;
    error: string | null;
  };
  observation?: CapabilityObservation | null;
}

export type CapabilityAccessState =
  | "loading"
  | "available"
  | "limited-offline"
  | "offline"
  | "denied"
  | "not-configured"
  | "plan-required"
  | "partial-not-configured"
  | "partial-plan-required"
  | "read-only"
  | "preview"
  | "mixed";

export interface CapabilityAccessDecision {
  state: CapabilityAccessState;
  /** Whether the destination can render. Discovery remains available always. */
  canEnter: boolean;
  label: string | null;
  reason: string | null;
  recoverySection?: Section;
}

const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

function readinessState(
  readiness: DesktopCapabilityReadiness,
): CapabilityAccessState {
  switch (readiness) {
    case "read-only":
      return "read-only";
    case "preview":
      return "preview";
    case "mixed":
    case "conditional":
      return "mixed";
    case "operational":
    default:
      return "available";
  }
}

/**
 * Pure, fail-closed precedence for destination access.  Consumers must not
 * independently reinterpret role, connectivity, entitlement or readiness.
 */
export function resolveCapabilityAccess(
  section: Section,
  environment: CapabilityAccessEnvironment,
): CapabilityAccessDecision {
  const capability = capabilityForSection(section);
  const requiredRole = capability.entryRole;

  if (requiredRole && environment.roleStatus === "loading") {
    return {
      state: "loading",
      canEnter: false,
      label: "Checking access",
      reason: "Moosewave is confirming your workspace role.",
    };
  }

  if (
    requiredRole &&
    (environment.roleStatus !== "resolved" ||
      !environment.role ||
      ROLE_RANK[environment.role] < ROLE_RANK[requiredRole])
  ) {
    return {
      state: "denied",
      canEnter: false,
      label: "Access required",
      reason: `This destination requires the ${requiredRole} role. Your data has not been loaded.`,
      ...(capability.recoverySection
        ? { recoverySection: capability.recoverySection }
        : {}),
    };
  }

  if (capability.auditScope && environment.audit.loading) {
    return {
      state: "loading",
      canEnter: false,
      label: "Checking access",
      reason: "Moosewave is confirming your audit permissions.",
    };
  }

  // `isAdmin` describes the effective workspace role for presentation-only
  // surfaces. It is not an audit permission wildcard: administrators can have
  // an individual audit grant removed in roles_permissions, and the API will
  // deny that route. Only an explicit audit scope (or the literal legacy/API
  // key `admin` scope, which the server treats as a wildcard) may unlock the
  // destination here.
  const hasRequiredAuditScope = capability.auditScope
    ? environment.audit.scopes.has("admin") ||
      environment.audit.scopes.has(capability.auditScope)
    : true;
  if (
    capability.auditScope &&
    (environment.audit.error !== null || !hasRequiredAuditScope)
  ) {
    return {
      state: "denied",
      canEnter: false,
      label: environment.audit.error
        ? "Access check unavailable"
        : "Access required",
      reason: environment.audit.error
        ? "Moosewave could not confirm audit access. It failed closed; retry before viewing sensitive records."
        : `This destination requires ${capability.auditScope}. Ask a workspace owner to grant it.`,
      ...(capability.recoverySection
        ? { recoverySection: capability.recoverySection }
        : {}),
    };
  }

  if (environment.online === "offline") {
    if (capability.offline === "retained-session") {
      return {
        state: "limited-offline",
        canEnter: true,
        label: "Offline · retained session only",
        reason:
          "Only data already verified in this open session may remain visible. It is not an offline cache; refreshes and writes are unavailable, and reload clears it.",
      };
    }
    if (capability.offline === "cached") {
      return {
        state: "limited-offline",
        canEnter: true,
        label: "Offline · cached data only",
        reason:
          "Only previously encrypted, unexpired data may appear. Refreshes and online-only actions remain unavailable.",
      };
    }
    return {
      state: "offline",
      canEnter: false,
      label: "Connection required",
      reason:
        "This destination has no reviewed offline data path. Moosewave will not show an empty state or imply that remote data is current.",
    };
  }

  const observation = environment.observation;
  if (observation?.state === "plan-required") {
    return {
      state: "plan-required",
      canEnter: false,
      label: "Plan required",
      reason: observation.reason,
      recoverySection: "settings",
    };
  }
  if (observation?.state === "not-configured") {
    return {
      state: "not-configured",
      canEnter: false,
      label: "Not configured",
      reason: observation.reason,
      recoverySection: capability.recoverySection ?? "integrations",
    };
  }
  if (observation?.state === "partial-plan-required") {
    return {
      state: "partial-plan-required",
      canEnter: true,
      label: "Partially available · plan required",
      reason: observation.reason,
      recoverySection: "settings",
    };
  }
  if (observation?.state === "partial-not-configured") {
    return {
      state: "partial-not-configured",
      canEnter: true,
      label: "Partially available · setup required",
      reason: observation.reason,
      recoverySection: capability.recoverySection ?? "integrations",
    };
  }

  const state = readinessState(capability.readiness);
  return {
    state,
    canEnter: true,
    label: capabilityReadinessLabel(capability.readiness),
    reason: capability.limitation ?? null,
    ...(capability.recoverySection
      ? { recoverySection: capability.recoverySection }
      : {}),
  };
}

export function isCapabilityBlocked(
  decision: CapabilityAccessDecision,
): boolean {
  return !decision.canEnter;
}
