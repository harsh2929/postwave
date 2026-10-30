// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCompatibilityDemoActions } from "@/app/(dashboard)/app/compatibility/use-compatibility-demo-actions";
import type {
  AccountExportsResponse,
  BatchesResponse,
  CampaignReport,
  CreativeAssistantResponse,
  MailchimpParityWorkbenchResponse,
  TemplateLanguagePreviewResponse,
  VideoConvertResponse,
} from "@/lib/mailchimp-compat-api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createResource: vi.fn(),
}));

vi.mock("@/lib/mailchimp-compat-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mailchimp-compat-api")>()),
  createCompatResource: mocks.createResource,
}));

function Harness({
  authorityKey,
  beforeWrite,
  refresh,
}: {
  authorityKey: string;
  beforeWrite: (signal: AbortSignal) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [, setAccountExports] = useState<AccountExportsResponse | null>(null);
  const [, setBatches] = useState<BatchesResponse | null>(null);
  const [, setCreativeDraft] = useState<CreativeAssistantResponse | null>(null);
  const [, setParityWorkbench] =
    useState<MailchimpParityWorkbenchResponse | null>(null);
  const [, setReport] = useState<CampaignReport | null>(null);
  const [, setTemplatePreview] =
    useState<TemplateLanguagePreviewResponse | null>(null);
  const [, setVideoConversion] = useState<VideoConvertResponse | null>(null);
  const actions = useCompatibilityDemoActions({
    authorityKey,
    beforeWrite,
    campaigns: [],
    demoActionsEnabled: true,
    groupsCount: 0,
    integrations: [],
    refresh,
    setAccountExports,
    setBatches,
    setCreativeDraft,
    setParityWorkbench,
    setReport,
    setTemplatePreview,
    setVideoConversion,
  });
  return (
    <button
      type="button"
      onClick={() =>
        void actions.runAction("Create group", actions.seedContactModel)
      }
    >
      {actions.busy ?? "Create group"}
    </button>
  );
}

function mount(props: React.ComponentProps<typeof Harness>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Harness, props)));
  return { container, root };
}

async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

let mounted: Root | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createResource.mockResolvedValue({ id: "group-1" });
});
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});

describe("compatibility demo write authority", () => {
  it("locks a synchronous double-click and verifies authority before the write", async () => {
    let release!: () => void;
    const beforeWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = mount({
      authorityKey: "tenant-a:admin",
      beforeWrite,
      refresh,
    });
    mounted = view.root;
    const action = view.container.querySelector("button")!;

    act(() => {
      action.click();
      action.click();
    });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(mocks.createResource).not.toHaveBeenCalled();

    await act(async () => release());
    await flush();
    expect(mocks.createResource).toHaveBeenCalledTimes(1);
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createResource.mock.invocationCallOrder[0],
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mocks.createResource.mock.calls[0]?.[2]?.signal).toBeInstanceOf(
      AbortSignal,
    );
  });

  it("aborts a frozen demo intent when the authority key changes", async () => {
    let release!: () => void;
    const beforeWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    const props = {
      authorityKey: "tenant-a:admin",
      beforeWrite,
      refresh,
    };
    const view = mount(props);
    mounted = view.root;
    act(() => view.container.querySelector("button")?.click());
    expect(beforeWrite).toHaveBeenCalledTimes(1);

    act(() => {
      view.root.render(
        createElement(Harness, {
          ...props,
          authorityKey: "tenant-b:admin",
        }),
      );
    });
    await act(async () => release());
    await flush();

    expect(mocks.createResource).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
