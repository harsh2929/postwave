/**
 * The app lock does not reach the OS notification shade.
 *
 * `BiometricGate` protects a React tree; a notification action button runs
 * BESIDE that tree, straight into this hook. So on a phone whose workspace was
 * locked behind Face ID, "Approve", "Reject" and "Revoke session" were still
 * one tap each for whoever was holding the handset — and the confirm sheet the
 * hook raises renders ABOVE the lock screen, so even the second step was
 * available to them. These tests pin the challenge that closes that path, and
 * pin equally hard that a phone with no app lock is not newly nagged and that
 * read-only navigation is left alone.
 */
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeAction {
  actionIdentifier: string;
  entityId: string;
  eventType?: string;
  userText?: string;
}
interface FakeResponse {
  __action: FakeAction | null;
}

const state = vi.hoisted(() => ({
  responseListener: null as ((response: FakeResponse) => void) | null,
  lockEnabled: true,
  deviceAuthResult: true,
  routeTarget: null as string | null,
}));

const requireDeviceAuth = vi.hoisted(() =>
  vi.fn(async (_reason: string) => state.deviceAuthResult),
);
const getBiometricLockEnabled = vi.hoisted(() =>
  vi.fn(async () => state.lockEnabled),
);
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
const toastMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const decideApprovalFromNotification = vi.hoisted(() =>
  vi.fn(async () => true),
);
const revokeSession = vi.hoisted(() => vi.fn(async () => ({ data: {} })));

vi.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: vi.fn(
    (listener: (response: FakeResponse) => void) => {
      state.responseListener = listener;
      return { remove: vi.fn() };
    },
  ),
}));

vi.mock("@/lib/biometric", () => ({
  getBiometricLockEnabled,
  requireDeviceAuth,
}));

vi.mock("@/api/authSessions", () => ({ revokeSession }));

vi.mock("@/components/ConfirmSheet", () => ({
  useConfirm: () => confirmMock,
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/hooks/useNavigateTo", () => ({
  useNavigateToHref: () => navigateMock,
}));

vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));

vi.mock("@/lib/deepLinks", () => ({
  routeForNotification: () => state.routeTarget,
}));

vi.mock("@/lib/haptics", () => ({
  haptics: {
    tap: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    impact: vi.fn(),
  },
}));

vi.mock("@/lib/push", () => ({
  decideApprovalFromNotification,
  lastNotificationResponse: vi.fn(async () => null),
  parseNotificationAction: (response: FakeResponse) => response.__action,
  PUSH_ACTION_APPROVE: "approve",
  PUSH_ACTION_REJECT: "reject",
}));

vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

vi.mock("@/store/auth", () => {
  const authState = {
    hydrated: true,
    sessionValidation: "valid",
    mode: "session" as const,
    baseUrl: "https://api.example.test",
    session: {
      effectiveRole: "owner",
      tenantId: "tenant-1",
      userId: "user-1",
    },
    canEnterApp: () => true,
    canUseOnlineServices: () => true,
  };
  const useAuthStore = (selector: (s: typeof authState) => unknown) =>
    selector(authState);
  useAuthStore.getState = () => authState;
  return { useAuthStore };
});

// eslint-disable-next-line import/first
import { usePushResponseRouting } from "./usePushResponseRouting";

function Harness() {
  usePushResponseRouting();
  return null;
}

async function mountAndDeliver(action: FakeAction | null): Promise<void> {
  await act(async () => {
    TestRenderer.create(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    state.responseListener?.({ __action: action });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const APPROVE: FakeAction = {
  actionIdentifier: "approve",
  entityId: "approval-1",
};
// 22 canonical unpadded base64url characters, the shape auth_sessions issues.
const REVOKE: FakeAction = {
  actionIdentifier: "revoke_session",
  eventType: "auth.new_device_sign_in",
  entityId: "AAAAAAAAAAAAAAAAAAAAAQ",
};

describe("notification action buttons behind an armed app lock", () => {
  beforeEach(() => {
    state.responseListener = null;
    state.lockEnabled = true;
    state.deviceAuthResult = true;
    state.routeTarget = null;
    requireDeviceAuth.mockClear();
    getBiometricLockEnabled.mockClear();
    confirmMock.mockClear();
    toastMock.mockClear();
    navigateMock.mockClear();
    decideApprovalFromNotification.mockClear();
    revokeSession.mockClear();
  });

  it("refuses an approval decision when the device owner cannot be proved", async () => {
    state.deviceAuthResult = false;
    await mountAndDeliver(APPROVE);

    expect(requireDeviceAuth).toHaveBeenCalledTimes(1);
    // The sheet is the second half of the bypass, not a safeguard: it renders
    // above the lock screen, so it must never even be raised.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(decideApprovalFromNotification).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "warning" }),
    );
  });

  it("lets the decision through once the owner passes the challenge", async () => {
    await mountAndDeliver(APPROVE);

    expect(requireDeviceAuth).toHaveBeenCalledTimes(1);
    expect(decideApprovalFromNotification).toHaveBeenCalledWith(
      "approval-1",
      "approve",
      undefined,
    );
  });

  it("does not challenge a phone that never armed the lock", async () => {
    // The lock is the whole premise of the challenge. Demanding Face ID from
    // someone who deliberately runs without it would be a new tax on the one
    // feature actionable pushes exist for.
    state.lockEnabled = false;
    await mountAndDeliver(APPROVE);

    expect(requireDeviceAuth).not.toHaveBeenCalled();
    expect(decideApprovalFromNotification).toHaveBeenCalledTimes(1);
  });

  it("refuses a security-alert session revoke when the owner cannot be proved", async () => {
    state.deviceAuthResult = false;
    await mountAndDeliver(REVOKE);

    expect(requireDeviceAuth).toHaveBeenCalledTimes(1);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("still revokes for an owner who passes the challenge", async () => {
    await mountAndDeliver(REVOKE);

    expect(revokeSession).toHaveBeenCalledWith(
      "https://api.example.test",
      "AAAAAAAAAAAAAAAAAAAAAQ",
    );
  });

  it("leaves read-only navigation unchallenged", async () => {
    // Opening a screen behind the lock reveals nothing: BiometricGate unmounts
    // the protected tree. Only state-changing verbs are gated.
    state.routeTarget = "/(tabs)/approvals";
    await mountAndDeliver(null);

    expect(requireDeviceAuth).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/(tabs)/approvals");
  });
});
