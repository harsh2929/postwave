/**
 * useRefreshControl: the pull-to-refresh spinner answers the operator's pull,
 * and nothing else.
 *
 * `refreshing` used to be `queries.some((q) => q.isRefetching)`. TanStack's
 * isRefetching is `isFetching && !isPending`, so it is true on EVERY refetch
 * after the first load: a poll tick, an invalidation, a reconnect. Twenty-two
 * screens bind this hook, and several are polled (subscriber imports every
 * 3-6 s while a job runs, a helpdesk thread every 10 s), so the spinner came
 * up with no finger on the glass. On iOS a programmatic `refreshing={true}`
 * also shifts the list's contentOffset by the control's height, so the list
 * visibly jumped on each poll.
 *
 * WHAT IS PINNED:
 *   - a background refetch nobody pulled for does not engage the spinner;
 *   - a pull engages it while that pull's fetch is on the wire and releases it
 *     when the fetch settles, after which a poll tick is background again;
 *   - a pull whose fetch is PAUSED offline (the refetch promise stays pending
 *     and isRefetching stays false) does not leave a spinner up. That is why
 *     the gesture flag is AND-ed with isRefetching instead of standing alone;
 *   - the one stable onRefresh reaches the refetch the screen holds NOW.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";

import {
  useRefreshControl,
  type RefreshableQuery,
} from "@/hooks/useRefreshControl";
import { haptics } from "@/lib/haptics";

jest.mock("@/lib/haptics", () => ({
  haptics: { tap: jest.fn() },
}));

type Props = {
  isRefetching: boolean;
  refetch: RefreshableQuery["refetch"];
};

/** A refetch whose settlement the test controls: the fetch "on the wire". */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function mount(refetch: RefreshableQuery["refetch"]) {
  return renderHook(
    (props: Props) =>
      useRefreshControl({
        isRefetching: props.isRefetching,
        refetch: props.refetch,
      }),
    { initialProps: { isRefetching: false, refetch } },
  );
}

describe("useRefreshControl", () => {
  it("does not spin for a background refetch nobody pulled for", async () => {
    const refetch = jest.fn(async () => undefined);
    const hook = await mount(refetch);

    // A poll tick (or an invalidation, or a reconnect) is now in flight.
    await hook.rerender({ isRefetching: true, refetch });

    expect(hook.result.current.refreshing).toBe(false);
    expect(refetch).not.toHaveBeenCalled();
    expect(haptics.tap).not.toHaveBeenCalled();
  });

  it("spins for the pull while its fetch is on the wire, then treats the next poll as background", async () => {
    const pull = deferred();
    const refetch = jest.fn(() => pull.promise);
    const hook = await mount(refetch);

    await act(async () => {
      hook.result.current.onRefresh();
    });
    await hook.rerender({ isRefetching: true, refetch });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.refreshing).toBe(true);
    // The haptic confirms completion, so it must not fire while in flight.
    expect(haptics.tap).not.toHaveBeenCalled();

    await act(async () => {
      pull.resolve();
    });
    await hook.rerender({ isRefetching: false, refetch });

    expect(hook.result.current.refreshing).toBe(false);
    expect(haptics.tap).toHaveBeenCalledTimes(1);

    // The next poll tick, after the pull has settled, is background again.
    await hook.rerender({ isRefetching: true, refetch });

    expect(hook.result.current.refreshing).toBe(false);
    expect(haptics.tap).toHaveBeenCalledTimes(1);
  });

  it("does not leave a spinner up for a pull whose fetch is paused offline", async () => {
    // TanStack's refetch() while offline: the promise stays pending,
    // fetchStatus is "paused" and isRefetching stays false. A spinner bound to
    // the gesture alone would hang here until the device came back online.
    const refetch = jest.fn(() => new Promise<void>(() => {}));
    const hook = await mount(refetch);

    await act(async () => {
      hook.result.current.onRefresh();
    });
    await hook.rerender({ isRefetching: false, refetch });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.refreshing).toBe(false);
    expect(haptics.tap).not.toHaveBeenCalled();
  });

  it("keeps one onRefresh across renders, and it reaches the refetch the screen holds now", async () => {
    const first = jest.fn(async () => undefined);
    const hook = await mount(first);
    const onRefresh = hook.result.current.onRefresh;

    // A hand-composed binding (sms, helpdesk) hands a new refetch identity.
    const second = jest.fn(async () => undefined);
    await hook.rerender({ isRefetching: false, refetch: second });

    expect(hook.result.current.onRefresh).toBe(onRefresh);

    await act(async () => {
      onRefresh();
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stays silent when the pull settles after the screen is gone", async () => {
    const pull = deferred();
    const refetch = jest.fn(() => pull.promise);
    const hook = await mount(refetch);

    await act(async () => {
      hook.result.current.onRefresh();
    });
    await hook.unmount();
    await act(async () => {
      pull.resolve();
    });

    expect(refetch).toHaveBeenCalledTimes(1);
    expect(haptics.tap).not.toHaveBeenCalled();
  });
});
