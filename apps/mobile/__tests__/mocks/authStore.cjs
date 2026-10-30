class AuthSessionStateError extends Error {}
class LocalAuthPersistenceError extends Error {}

const session = {
  email: "owner@example.test",
  effectiveRole: "owner",
  mfaEnrolled: true,
  mfaRequired: false,
  mfaSatisfied: true,
  role: "owner",
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  workspaceName: "Test workspace",
};

const state = {
  authWarning: null,
  clearAuthWarning: jest.fn(),
  baseUrl: "https://api.moosewave.com",
  canEnterApp: () => true,
  canUseOnlineServices: () => true,
  cancelSession: jest.fn(async () => undefined),
  hydrate: jest.fn(async () => undefined),
  hydrated: true,
  localCleanupPending: false,
  mfaGate: () => null,
  mode: "session",
  prepareForSessionAuthentication: jest.fn(async () => undefined),
  refreshSessionFromServer: jest.fn(async () => session),
  refreshSessionProfile: jest.fn(async () => session),
  retryLocalCleanup: jest.fn(async () => undefined),
  revalidateSession: jest.fn(async () => undefined),
  session,
  sessionValidation: "validated_online",
  signIn: jest.fn(async () => undefined),
  signInSession: jest.fn(async () => undefined),
  signingIn: false,
  signOut: jest.fn(async () => undefined),
  tenantId: session.tenantId,
};

/**
 * Per-test overrides.
 *
 * The default fixture is an OWNER session, which silently made every
 * role-gated control render for every test — so a screen that forgot its
 * `canAccessMinimumRole` check looked identical to one that had it. Screens
 * that read the role from the auth store (rather than from the online-query
 * gate) need to be able to close that gate; `__setAuthStateForTests` is the
 * lever, and `__resetAuthStateForTests` restores the owner default.
 *
 * `session` is merged rather than replaced so a caller can flip only the role.
 */
let overrides = null;

function current() {
  if (!overrides) return state;
  return {
    ...state,
    ...overrides,
    session:
      overrides.session === null
        ? null
        : { ...state.session, ...(overrides.session ?? {}) },
  };
}

function useAuthStore(selector) {
  return selector(current());
}
useAuthStore.getState = () => current();
useAuthStore.setState = jest.fn();
useAuthStore.subscribe = jest.fn(() => jest.fn());

module.exports = {
  __setAuthStateForTests: (value) => {
    overrides = { ...(overrides ?? {}), ...value };
  },
  __resetAuthStateForTests: () => {
    overrides = null;
  },
  AuthSessionStateError,
  LocalAuthPersistenceError,
  destinationForSession: () => "/(tabs)/dashboard",
  getPushToken: jest.fn(async () => null),
  needsMfaSecurityStepUp: () => false,
  sessionProfileFromMe: () => session,
  useAuthStore,
};
