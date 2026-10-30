/** Shared fail-closed identity comparisons for Route42 suppression writes. */
export interface SmsSuppressionSessionProfile {
  tenantId: string;
  userId: string;
  effectiveRole: string;
}

export interface SmsSuppressionAuthSnapshot {
  baseUrl: string | null;
  mode: string | null;
  session: SmsSuppressionSessionProfile | null;
  sessionValidation: string;
  canUseOnlineServices: () => boolean;
  refreshSessionFromServer: () => Promise<SmsSuppressionSessionProfile>;
}

export interface SmsSuppressionExpectedAuthority {
  baseUrl: string | null;
  tenantId: string | null;
  userId: string | null;
  effectiveRole: string | null;
}

function isEffectiveAdmin(role: string | null | undefined): boolean {
  return role === "admin" || role === "owner";
}

export function captureSmsSuppressionAuthority(
  snapshot: SmsSuppressionAuthSnapshot,
): SmsSuppressionExpectedAuthority {
  return {
    baseUrl: snapshot.baseUrl,
    tenantId: snapshot.session?.tenantId ?? null,
    userId: snapshot.session?.userId ?? null,
    effectiveRole: snapshot.session?.effectiveRole ?? null,
  };
}

export function canBeginSmsSuppressionWrite(
  snapshot: SmsSuppressionAuthSnapshot,
  expected: SmsSuppressionExpectedAuthority,
  expectedTenantId: string | null,
): expectedTenantId is string {
  return (
    snapshot.mode === "session" &&
    Boolean(expected.baseUrl) &&
    Boolean(expectedTenantId) &&
    expected.tenantId === expectedTenantId &&
    Boolean(expected.userId) &&
    isEffectiveAdmin(expected.effectiveRole)
  );
}

export function refreshedSmsSuppressionAuthorityMatches(
  profile: SmsSuppressionSessionProfile,
  current: SmsSuppressionAuthSnapshot,
  expected: SmsSuppressionExpectedAuthority,
): boolean {
  return (
    profile.tenantId === expected.tenantId &&
    profile.userId === expected.userId &&
    isEffectiveAdmin(profile.effectiveRole) &&
    current.mode === "session" &&
    current.baseUrl === expected.baseUrl &&
    current.session?.tenantId === expected.tenantId &&
    current.session?.userId === expected.userId &&
    current.session?.effectiveRole === profile.effectiveRole &&
    current.sessionValidation === "validated_online" &&
    current.canUseOnlineServices()
  );
}

export function finalSmsSuppressionAuthorityMatches(
  current: SmsSuppressionAuthSnapshot,
  expected: SmsSuppressionExpectedAuthority,
  refreshedRole: string,
): boolean {
  return (
    current.mode === "session" &&
    current.baseUrl === expected.baseUrl &&
    current.session?.tenantId === expected.tenantId &&
    current.session?.userId === expected.userId &&
    current.session?.effectiveRole === refreshedRole &&
    current.sessionValidation === "validated_online" &&
    current.canUseOnlineServices()
  );
}

export function smsSuppressionResponseStatus(error: unknown): number {
  return error && typeof error === "object" && "status" in error
    ? Number((error as { status?: unknown }).status)
    : 0;
}
