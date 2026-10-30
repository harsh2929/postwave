import { act, renderHook, waitFor } from "@testing-library/react-native";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

import {
  type AuthSnapshot,
  type SessionCancellationResult,
  useAuthStore,
} from "@/store/auth";

type AsyncMock = (...args: unknown[]) => Promise<unknown>;

const mockStartGrant = jest.fn<AsyncMock>();
const mockPollGrant = jest.fn<AsyncMock>();
const mockConfirmGrant = jest.fn<AsyncMock>();
const mockCancelGrant = jest.fn<AsyncMock>();
const mockGetMe = jest.fn<AsyncMock>();

jest.mock("@/api/deviceSessionSignIn", () => ({
  startDeviceSessionGrant: (...args: unknown[]) => mockStartGrant(...args),
  pollDeviceSessionGrant: (...args: unknown[]) => mockPollGrant(...args),
  confirmDeviceSessionGrant: (...args: unknown[]) => mockConfirmGrant(...args),
  cancelDeviceSessionGrant: (...args: unknown[]) => mockCancelGrant(...args),
  decideDeviceSessionPoll: (error: {
    code?: string;
    kind?: string;
    status?: number;
    message?: string;
  }) => {
    if (error.code === "authorization_pending") return { kind: "pending" };
    if (error.code === "slow_down") return { kind: "slow_down" };
    if (error.code === "access_denied") return { kind: "denied" };
    if (error.code === "expired_token") return { kind: "expired" };
    if (
      error.kind === "network" ||
      error.kind === "timeout" ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500)
    ) {
      return { kind: "network" };
    }
    return { kind: "fatal", message: error.message ?? "invalid response" };
  },
}));

jest.mock("@/api/auth", () => ({
  createAuthClient: () => ({ getMe: () => mockGetMe() }),
}));

// Imported after the factories so their closure-backed mocks are initialized.
// eslint-disable-next-line import/first
import { useDeviceSessionSignIn } from "@/hooks/useDeviceSessionSignIn";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const START_GRANT = {
  data: {
    deviceCode: "memory-only-device-secret",
    userCode: "BCDF-GHJK",
    verificationUri: "https://app.moosewave.com/cli/auth",
    verificationUriComplete:
      "https://app.moosewave.com/cli/auth?user_code=BCDF-GHJK",
    expiresIn: 600,
    interval: 5,
    remember: false,
  },
};

const PROVISIONAL_SESSION = {
  data: {
    grant_kind: "session",
    session: true,
    confirmation_required: true,
    confirmation_expires_in: 120,
    expires_in: 43_200,
    remember: false,
  },
};

const CONFIRMED_SESSION = {
  data: {
    grant_kind: "session",
    session: true,
    confirmed: true,
    confirmation_required: false,
    expires_in: 43_200,
    remember: false,
  },
};

const AUTH_SNAPSHOT: AuthSnapshot = {
  apiKey: null,
  baseUrl: "https://api.moosewave.com",
  tenantId: null,
  session: null,
  mode: null,
};

const CANCELLATION_RESULT: SessionCancellationResult = {
  cleanup: { complete: true, failedAreas: [] },
  serverRevocationPending: false,
};

type StoreState = ReturnType<typeof useAuthStore.getState>;

function storeMocks(): {
  signInSession: jest.MockedFunction<StoreState["signInSession"]>;
  cancelSession: jest.MockedFunction<StoreState["cancelSession"]>;
  prepare: jest.MockedFunction<StoreState["prepareForSessionAuthentication"]>;
} {
  const store = useAuthStore.getState();
  return {
    signInSession: store.signInSession as jest.MockedFunction<
      StoreState["signInSession"]
    >,
    cancelSession: store.cancelSession as jest.MockedFunction<
      StoreState["cancelSession"]
    >,
    prepare: store.prepareForSessionAuthentication as jest.MockedFunction<
      StoreState["prepareForSessionAuthentication"]
    >,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockStartGrant.mockResolvedValue(START_GRANT);
  mockPollGrant.mockResolvedValue(PROVISIONAL_SESSION);
  mockConfirmGrant.mockResolvedValue(CONFIRMED_SESSION);
  mockCancelGrant.mockResolvedValue(undefined);
  mockGetMe.mockResolvedValue({ data: {} });
  const store = storeMocks();
  store.prepare.mockResolvedValue(undefined);
  store.signInSession.mockResolvedValue(AUTH_SNAPSHOT);
  store.cancelSession.mockResolvedValue(CANCELLATION_RESULT);
});

afterEach(() => {
  jest.useRealTimers();
});

async function beginExchange(
  flow: ReturnType<typeof useDeviceSessionSignIn>,
): Promise<void> {
  await act(async () => {
    await flow.start();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5_000);
  });
}

describe("mobile device-session lifecycle", () => {
  it("exact-cancels a malformed poll result that may have installed a provisional cookie", async () => {
    mockPollGrant.mockResolvedValueOnce({
      error: {
        code: "invalid_device_grant",
        kind: "parse",
        message: "malformed 200 response",
      },
    });
    const onSignedIn = jest.fn();
    const { result } = await renderHook(() =>
      useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn,
      }),
    );

    await beginExchange(result.current);

    expect(mockCancelGrant).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "memory-only-device-secret",
    );
    expect(mockConfirmGrant).not.toHaveBeenCalled();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(result.current.state).toMatchObject({
      phase: "error",
      reason: "unavailable",
    });
  });

  it("retries confirmation with the same code before verifying the session", async () => {
    mockConfirmGrant
      .mockResolvedValueOnce({
        error: {
          code: "session_retry",
          kind: "http",
          status: 503,
          message: "retry",
        },
      })
      .mockResolvedValueOnce(CONFIRMED_SESSION);
    const onSignedIn = jest.fn();
    const { result } = await renderHook(() =>
      useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn,
      }),
    );

    await beginExchange(result.current);
    expect(mockConfirmGrant).toHaveBeenCalledTimes(1);
    expect(mockGetMe).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });

    expect(mockConfirmGrant).toHaveBeenCalledTimes(2);
    expect(mockConfirmGrant).toHaveBeenNthCalledWith(
      1,
      "https://api.moosewave.com",
      "memory-only-device-secret",
      false,
      expect.any(AbortSignal),
    );
    expect(mockConfirmGrant).toHaveBeenNthCalledWith(
      2,
      "https://api.moosewave.com",
      "memory-only-device-secret",
      false,
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(mockCancelGrant).not.toHaveBeenCalled();
  });

  it("uses the confirmation lease instead of the original grant deadline", async () => {
    mockPollGrant.mockResolvedValueOnce({
      data: {
        ...PROVISIONAL_SESSION.data,
        confirmation_expires_in: 2,
      },
    });
    mockConfirmGrant.mockResolvedValue({
      error: {
        code: "session_retry",
        kind: "http",
        status: 503,
        message: "retry",
      },
    });
    const { result } = await renderHook(() =>
      useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn: jest.fn(),
      }),
    );

    await beginExchange(result.current);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_999);
    });
    expect(mockCancelGrant).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockCancelGrant).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "memory-only-device-secret",
    );
    expect(result.current.state).toMatchObject({
      phase: "error",
      reason: "expired",
    });
  });

  it("clears a secure session that finishes persisting after cancellation", async () => {
    const persisted = deferred<AuthSnapshot>();
    const store = storeMocks();
    store.signInSession.mockReturnValueOnce(persisted.promise);
    const onSignedIn = jest.fn();
    const { result } = await renderHook(() =>
      useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn,
      }),
    );

    await beginExchange(result.current);
    expect(store.signInSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      const cancellation = result.current.cancel();
      persisted.resolve(AUTH_SNAPSHOT);
      await Promise.all([persisted.promise, cancellation]);
    });

    expect(mockCancelGrant).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "memory-only-device-secret",
    );
    await waitFor(() =>
      expect(store.cancelSession).toHaveBeenCalledWith(
        "https://api.moosewave.com",
      ),
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("does not let an old persistence cleanup revoke a newer device flow", async () => {
    const persisted = deferred<AuthSnapshot>();
    const store = storeMocks();
    store.signInSession.mockReturnValueOnce(persisted.promise);
    const flows = await renderHook(() => {
      const oldFlow = useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn: jest.fn(),
      });
      const newFlow = useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn: jest.fn(),
      });
      return { oldFlow, newFlow };
    });
    await beginExchange(flows.result.current.oldFlow);

    await act(async () => {
      const cancellation = flows.result.current.oldFlow.cancel();
      const newStart = flows.result.current.newFlow.start();
      await Promise.resolve();
      expect(mockStartGrant).toHaveBeenCalledTimes(1);
      persisted.resolve(AUTH_SNAPSHOT);
      await Promise.all([persisted.promise, cancellation, newStart]);
    });

    expect(store.cancelSession).toHaveBeenCalledWith(
      "https://api.moosewave.com",
    );
    expect(mockStartGrant).toHaveBeenCalledTimes(2);
    expect(store.cancelSession.mock.invocationCallOrder[0]).toBeLessThan(
      mockStartGrant.mock.invocationCallOrder[1]!,
    );
  });

  it("clears a secure session that finishes persisting after unmount", async () => {
    const persisted = deferred<AuthSnapshot>();
    const store = storeMocks();
    store.signInSession.mockReturnValueOnce(persisted.promise);
    const onSignedIn = jest.fn();
    const { result, unmount } = await renderHook(() =>
      useDeviceSessionSignIn({
        baseUrl: "https://api.moosewave.com",
        remember: false,
        onSignedIn,
      }),
    );

    await beginExchange(result.current);
    expect(store.signInSession).toHaveBeenCalledTimes(1);
    await unmount();
    await act(async () => {
      persisted.resolve(AUTH_SNAPSHOT);
      await persisted.promise;
    });

    expect(mockCancelGrant).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "memory-only-device-secret",
    );
    await waitFor(() =>
      expect(store.cancelSession).toHaveBeenCalledWith(
        "https://api.moosewave.com",
      ),
    );
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
