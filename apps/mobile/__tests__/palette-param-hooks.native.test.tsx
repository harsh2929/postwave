/**
 * The two param consumers the palette's verbs and sections depend on.
 *
 * `useSettingsAnchorParam` — the settings screen's side of `?anchor=`. The
 * subtle part is TIMING: section offsets register on layout, a frame or more
 * after the param is readable, and a hook that jumped on the first render
 * would find no offset and fire the "isn't available for your role" notice
 * for a section that was merely not measured yet. So: no jump until the
 * offset exists; a jump anyway once patience runs out (that is the honest
 * role-denied path); the param cleared afterwards so a re-focus cannot yank
 * the scroll again.
 *
 * `useCreateParam` — the lists/forms side of `?new=1`, the idiom
 * campaigns/index.tsx carries inline: open once, then clear the flag.
 *
 * `router.setParams` is not on the expo-router mock (nothing needed it before
 * this), so each test attaches one and removes it — the mock file is owned
 * elsewhere.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, waitFor } from "@testing-library/react-native";
import * as ExpoRouter from "expo-router";

import type { SettingsAnchorRegistry } from "@/components/settings/SettingsAnchors";
import { useCreateParam } from "@/hooks/useCreateParam";
import { useSettingsAnchorParam } from "@/hooks/useSettingsAnchorParam";

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (over: Record<string, string> | null) => void;
  router: { setParams?: jest.Mock };
};

beforeEach(() => {
  routerHarness.router.setParams = jest.fn();
});

afterEach(() => {
  routerHarness.__setSearchParamsForTests(null);
  delete routerHarness.router.setParams;
});

function AnchorHarness({
  registry,
  jump,
}: {
  registry: SettingsAnchorRegistry;
  jump: (key: string) => void;
}) {
  useSettingsAnchorParam(registry, jump);
  return null;
}

function CreateHarness({ onCreate }: { onCreate: () => void }) {
  useCreateParam(onCreate);
  return null;
}

/** A registry whose offsets a test can fill in after mount, like onLayout. */
function registryOver(offsets: Record<string, number>): SettingsAnchorRegistry {
  return {
    register: jest.fn(),
    offsetFor: (key) => (key in offsets ? offsets[key]! : null),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

describe("useSettingsAnchorParam", () => {
  it("waits for the section to lay out, jumps once, then clears the param", async () => {
    const offsets: Record<string, number> = {};
    const jump = jest.fn();
    routerHarness.__setSearchParamsForTests({ anchor: "app-lock" });

    await render(<AnchorHarness registry={registryOver(offsets)} jump={jump} />);

    // Not measured yet: no jump, and therefore no role notice either.
    expect(jump).not.toHaveBeenCalled();

    offsets["app-lock"] = 1240;
    await waitFor(() => expect(jump).toHaveBeenCalledWith("app-lock"));
    expect(jump).toHaveBeenCalledTimes(1);
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      anchor: undefined,
    });
  });

  it("jumps once patience runs out, so a never-mounted section reaches the role notice", async () => {
    const jump = jest.fn();
    routerHarness.__setSearchParamsForTests({ anchor: "workspace" });

    await render(<AnchorHarness registry={registryOver({})} jump={jump} />);

    await waitFor(() => expect(jump).toHaveBeenCalledWith("workspace"), {
      timeout: 3000,
    });
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      anchor: undefined,
    });
  });

  it("ignores an anchor the IA does not declare", async () => {
    const jump = jest.fn();
    routerHarness.__setSearchParamsForTests({ anchor: "nope" });

    await render(
      <AnchorHarness registry={registryOver({ nope: 10 })} jump={jump} />,
    );
    await settle();

    expect(jump).not.toHaveBeenCalled();
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });

  it("does nothing without the param", async () => {
    const jump = jest.fn();

    await render(
      <AnchorHarness registry={registryOver({ account: 0 })} jump={jump} />,
    );
    await settle();

    expect(jump).not.toHaveBeenCalled();
  });
});

describe("useCreateParam", () => {
  it("opens once on arrival and clears the flag", async () => {
    const onCreate = jest.fn();
    routerHarness.__setSearchParamsForTests({ new: "1" });

    const view = await render(<CreateHarness onCreate={onCreate} />);
    // A re-render with a fresh inline callback identity must not reopen.
    await view.rerender(<CreateHarness onCreate={onCreate} />);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(routerHarness.router.setParams).toHaveBeenCalledWith({
      new: undefined,
    });
  });

  it("does nothing without the flag, or with any other value", async () => {
    const onCreate = jest.fn();

    await render(<CreateHarness onCreate={onCreate} />);
    routerHarness.__setSearchParamsForTests({ new: "0" });
    await render(<CreateHarness onCreate={onCreate} />);

    expect(onCreate).not.toHaveBeenCalled();
    expect(routerHarness.router.setParams).not.toHaveBeenCalled();
  });
});
