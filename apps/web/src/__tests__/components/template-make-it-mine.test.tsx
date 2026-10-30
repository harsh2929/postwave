// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GenerateTemplateDialog } from "@/app/(dashboard)/app/templates/_components/generate-template-dialog";
import { AdaptTemplateDialog } from "@/app/(dashboard)/app/templates/_components/template-actions";
import type {
  CampaignTemplate,
  CampaignTemplateDesignDraft,
  CampaignTemplateDesignRevision,
} from "@/lib/campaign-templates-api";
import { ApiError } from "@/lib/api";
import {
  readCampaignTemplateDesignSession,
  writeCampaignTemplateDesignSession,
} from "@/lib/campaign-template-design-session";
import { VerifiedAuthScopeProvider } from "@/lib/auth-scope";

const RECOVERY_SCOPE = { userId: "user-1", tenantId: "tenant-1" };
const VERIFIED_SCOPE = {
  ...RECOVERY_SCOPE,
  canWriteCampaigns: true,
};

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createDesign: vi.fn(),
  listDesigns: vi.fn(),
  getDesign: vi.fn(),
  revisions: vi.fn(),
  refine: vi.fn(),
  retry: vi.fn(),
  archive: vi.fn(),
  save: vi.fn(),
  search: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/use-template-generation-availability", () => ({
  useTemplateGenerationAvailability: () => "available",
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return {
    ...actual,
    createCampaignTemplateDesign: mocks.createDesign,
    listCampaignTemplateDesigns: mocks.listDesigns,
    getCampaignTemplateDesign: mocks.getDesign,
    listCampaignTemplateDesignRevisions: mocks.revisions,
    refineCampaignTemplateDesign: mocks.refine,
    retryCampaignTemplateDesign: mocks.retry,
    archiveCampaignTemplateDesign: mocks.archive,
    saveCampaignTemplateDesign: mocks.save,
    searchCampaignTemplates: mocks.search,
  };
});

vi.mock("@/lib/forms-api", () => ({ listLists: vi.fn(async () => []) }));
vi.mock("@/lib/segments-api", () => ({
  listSegments: vi.fn(async () => []),
}));

function revision(): CampaignTemplateDesignRevision {
  return {
    id: "revision-1",
    draft_id: "design-1",
    revision: 1,
    operation: "initial",
    output: {
      name: "Original weekly",
      subject: "A new signal",
      body_html: "<p>Reviewed result</p>",
      variables: {},
      unresolved_variables: [],
      reference_template_ids: ["reference-1"],
      warnings: [],
    },
    output_hash: "a".repeat(64),
    validation: {
      status: "pass",
      checks: [
        {
          code: "unsafe_markup",
          status: "pass",
          message: "No unsafe markup found.",
        },
      ],
    },
    warnings: [],
    created_at: "2026-07-29T00:00:00Z",
  };
}

function readyDesign(): CampaignTemplateDesignDraft {
  return {
    id: "design-1",
    mode: "adapt",
    status: "ready",
    source_template_id: "reference-1",
    reference_template_ids: ["reference-1"],
    current_revision: 1,
    revision: revision(),
    attempt_count: 1,
    capabilities: {
      can_refine: true,
      can_retry: false,
      can_save: true,
      can_create_campaign: true,
      can_archive: true,
    },
    recommended_action: "review_campaign_template_design",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
    request: {
      mode: "adapt",
      source_template_id: "reference-1",
      instructions: "A weekly launch digest for founders.",
    },
  };
}

function failedDesign(): CampaignTemplateDesignDraft {
  return {
    ...readyDesign(),
    status: "failed",
    current_revision: 0,
    revision: undefined,
    last_error_code: "generator_unavailable",
    last_error_message: "The design generator is temporarily unavailable.",
    capabilities: {
      can_refine: false,
      can_retry: true,
      can_save: false,
      can_create_campaign: false,
      can_archive: true,
    },
  };
}

function secondRevisionDesign(): CampaignTemplateDesignDraft {
  const next = revision();
  next.id = "revision-2";
  next.revision = 2;
  next.operation = "refine";
  next.base_revision = 1;
  next.output.name = "Original weekly, refined";
  next.output_hash = "b".repeat(64);
  return {
    ...readyDesign(),
    current_revision: 2,
    revision: next,
  };
}

function scoped(ui: ReactNode, scope = VERIFIED_SCOPE): ReactNode {
  return createElement(VerifiedAuthScopeProvider, { scope }, ui);
}

function render(ui: ReactNode, scope = VERIFIED_SCOPE): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(scoped(ui, scope)));
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function click(button: Element): void {
  act(() => {
    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

function enterValue(
  element: HTMLTextAreaElement | HTMLInputElement,
  value: string,
) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function reference(
  overrides: Partial<CampaignTemplate> = {},
): CampaignTemplate {
  return {
    id: "reference-1",
    name: "Editorial Signal",
    subject: "Weekly signal",
    tags: [],
    template_kind: "reference",
    review_status: "approved",
    source_license_status: "owned",
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_adapt: true,
      can_use_directly: false,
      can_edit_directly: false,
      can_clone: false,
      can_create_campaign: false,
      can_delete: false,
      has_source_html: false,
      has_source_mjml: false,
      has_desktop_preview: true,
      has_mobile_preview: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.search.mockResolvedValue({
    items: [],
    next_cursor: null,
    total: 0,
    facets: {},
  });
  mocks.listDesigns.mockResolvedValue({ items: [], generation_available: true });
  mocks.revisions.mockResolvedValue({ items: [revision()] });
  mocks.getDesign.mockResolvedValue(readyDesign());
  mocks.archive.mockResolvedValue({
    ...readyDesign(),
    status: "archived",
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Make it mine durable template flow", () => {
  it("truthfully disables adaptation without an affirmative server capability", () => {
    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference({
          review_status: "pending",
          source_license_status: "personal-use-unreviewed",
          capabilities: {
            ...reference().capabilities!,
            can_adapt: false,
          },
        }),
        label: "Make it mine",
      }),
    );

    try {
      const button = document.querySelector("button") as HTMLButtonElement;
      expect(button.textContent).toMatch(/awaiting review/i);
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(
        document.getElementById(button.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toMatch(/awaiting review/i);
    } finally {
      act(() => root.unmount());
    }
  });

  it("starts a durable adaptation and reviews the immutable output", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();

      expect(document.body.textContent).toContain("Visual inspiration");
      expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(3);

      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A weekly launch digest for founders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.createDesign).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "adapt",
          source_template_id: "reference-1",
          instructions: "A weekly launch digest for founders.",
          fidelity: "balanced",
        }),
        expect.objectContaining({
          idempotencyKey: expect.any(String),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
      expect(document.body.textContent).toContain("Validation pass");
      expect(document.body.textContent).toContain("Side by side");
      expect(document.body.textContent).toContain("Save this version");
      expect(document.body.textContent).toContain("Mobile");
      expect(document.body.textContent).toContain("Dark canvas");

      const resultTab = Array.from(
        document.querySelectorAll('[role="tab"]'),
      ).find((tab) => tab.textContent?.includes("Your result"))!;
      act(() => {
        resultTab.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "ArrowRight",
            bubbles: true,
          }),
        );
      });
      expect(
        Array.from(document.querySelectorAll('[role="tab"]'))
          .find((tab) => tab.textContent?.includes("Inspiration"))
          ?.getAttribute("aria-selected"),
      ).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("confirms closing an adaptation only while create acknowledgement is pending", async () => {
    let acknowledge!: (draft: CampaignTemplateDesignDraft) => void;
    mocks.createDesign.mockReturnValue(
      new Promise<CampaignTemplateDesignDraft>((resolve) => {
        acknowledge = resolve;
      }),
    );

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A carefully scoped adaptation.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();

      click(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Close",
        )!,
      );
      expect(document.body.textContent).toContain(
        "Leave before Moosewave confirms?",
      );
      expect(document.body.textContent).toContain("Keep waiting");

      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Keep waiting"),
        )!,
      );
      act(() => acknowledge(readyDesign()));
      await flush();
      await flush();

      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
      click(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Close",
        )!,
      );
      expect(document.body.textContent).not.toContain(
        "Leave before Moosewave confirms?",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("protects generic generation before acknowledgement and warns when durable storage fails", async () => {
    let acknowledge!: (draft: CampaignTemplateDesignDraft) => void;
    mocks.createDesign.mockReturnValue(
      new Promise<CampaignTemplateDesignDraft>((resolve) => {
        acknowledge = resolve;
      }),
    );
    const durableStorage = window.localStorage;
    const unavailableStorage = {
      get length() {
        return durableStorage.length;
      },
      clear: () => durableStorage.clear(),
      getItem: (key: string) => durableStorage.getItem(key),
      key: (index: number) => durableStorage.key(index),
      removeItem: (key: string) => durableStorage.removeItem(key),
      setItem: () => {
        throw new Error("Storage disabled");
      },
    } satisfies Storage;
    const storageWrite = vi
      .spyOn(window, "localStorage", "get")
      .mockReturnValue(unavailableStorage);
    const onOpenChange = vi.fn();
    const root = render(
      createElement(GenerateTemplateDialog, {
        open: true,
        onOpenChange,
        templates: [],
      }),
    );

    try {
      await flush();
      expect(document.body.textContent).toContain(
        "This browser cannot save your place",
      );
      enterValue(
        document.querySelector(
          "#template-generation-brief",
        ) as HTMLTextAreaElement,
        "A weekly design for product leaders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Generate design"),
        )!,
      );
      await flush();

      click(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Close",
        )!,
      );
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(document.body.textContent).toContain(
        "Leaving before confirmation may make the design hard to recover",
      );
      expect(document.body.textContent).toContain("Keep this window open");
      expect(document.body.textContent).not.toContain("Leave anyway");

      storageWrite.mockRestore();
      act(() => acknowledge(readyDesign()));
      await flush();
      await flush();
    } finally {
      storageWrite.mockRestore();
      act(() => root.unmount());
    }
  });

  it("keeps close guarded after an ambiguous create settles without recoverable storage", async () => {
    mocks.createDesign.mockRejectedValueOnce(
      new ApiError("Connection dropped", 0, undefined, {
        kind: "network",
      }),
    );
    const durableStorage = window.localStorage;
    const unavailableStorage = {
      get length() {
        return durableStorage.length;
      },
      clear: () => durableStorage.clear(),
      getItem: (key: string) => durableStorage.getItem(key),
      key: (index: number) => durableStorage.key(index),
      removeItem: (key: string) => durableStorage.removeItem(key),
      setItem: () => {
        throw new Error("Storage disabled");
      },
    } satisfies Storage;
    const storageWrite = vi
      .spyOn(window, "localStorage", "get")
      .mockReturnValue(unavailableStorage);
    const onOpenChange = vi.fn();
    const root = render(
      createElement(GenerateTemplateDialog, {
        open: true,
        onOpenChange,
        templates: [],
      }),
    );

    try {
      await flush();
      enterValue(
        document.querySelector(
          "#template-generation-brief",
        ) as HTMLTextAreaElement,
        "A recoverable weekly product brief.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Generate design"),
        )!,
      );
      await flush();
      await flush();
      click(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Close",
        )!,
      );

      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(document.body.textContent).toContain(
        "Leaving before confirmation may make the design hard to recover",
      );
    } finally {
      storageWrite.mockRestore();
      act(() => root.unmount());
    }
  });

  it("recovers the server design ID after a reload without regenerating", async () => {
    writeCampaignTemplateDesignSession(RECOVERY_SCOPE, {
      mode: "adapt",
      sourceTemplateId: "reference-1",
      designIds: ["design-1"],
      selectedDesignId: "design-1",
    });

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.getDesign).toHaveBeenCalledWith(
        "design-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.createDesign).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
    } finally {
      act(() => root.unmount());
    }
  });

  it("drops a stale or foreign 404 design ID from local recovery", async () => {
    writeCampaignTemplateDesignSession(RECOVERY_SCOPE, {
      mode: "adapt",
      sourceTemplateId: "reference-1",
      designIds: ["foreign-design"],
      selectedDesignId: "foreign-design",
    });
    mocks.getDesign.mockRejectedValueOnce(
      new ApiError("Not found", 404, undefined, {
        code: "design_draft_not_found",
        kind: "http",
      }),
    );
    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      await flush();

      expect(
        readCampaignTemplateDesignSession(
          RECOVERY_SCOPE,
          "adapt",
          "reference-1",
        ),
      ).toBeNull();
      expect(document.body.textContent).not.toContain("Saved snapshot");
      expect(document.body.textContent).toContain(
        "previous design is no longer available",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("recovers an actor-scoped server draft when local storage has no ID", async () => {
    mocks.listDesigns.mockResolvedValue({ items: [readyDesign()], generation_available: true });

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.listDesigns).toHaveBeenCalledWith(
        { limit: 50 },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.getDesign).toHaveBeenCalledWith(
        "design-1",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mocks.createDesign).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not retain or auto-replay a create rejected by offline preflight", async () => {
    mocks.createDesign.mockRejectedValueOnce(
      new ApiError("Offline", 0, undefined, {
        code: "offline",
        kind: "offline",
      }),
    );
    const onOpenChange = vi.fn();
    const dialog = createElement(GenerateTemplateDialog, {
      open: true,
      onOpenChange,
      templates: [],
    });
    const firstRoot = render(dialog);

    await flush();
    enterValue(
      document.querySelector(
        "#template-generation-brief",
      ) as HTMLTextAreaElement,
      "A weekly design for product leaders.",
    );
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Generate design"),
      )!,
    );
    await flush();
    await flush();

    expect(
      readCampaignTemplateDesignSession(RECOVERY_SCOPE, "generate")
        ?.pendingCreate,
    ).toBeUndefined();
    click(
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Close",
      )!,
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    act(() => firstRoot.unmount());

    const secondRoot = render(dialog);
    try {
      await flush();
      await flush();
      expect(mocks.createDesign).toHaveBeenCalledTimes(1);
    } finally {
      act(() => secondRoot.unmount());
    }
  });

  it("aborts and parks the old recovery scope during an account switch", async () => {
    writeCampaignTemplateDesignSession(RECOVERY_SCOPE, {
      mode: "adapt",
      sourceTemplateId: "reference-1",
      designIds: ["design-1"],
      selectedDesignId: "design-1",
    });
    let oldSignal: AbortSignal | undefined;
    mocks.getDesign.mockImplementation(
      (
        _id: string,
        options: {
          signal?: AbortSignal;
        },
      ) => {
        oldSignal = options.signal;
        return new Promise<CampaignTemplateDesignDraft>(() => undefined);
      },
    );
    const dialog = createElement(AdaptTemplateDialog, {
      template: reference(),
      label: "Make it mine",
    });
    const root = render(dialog);

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      expect(oldSignal).toBeInstanceOf(AbortSignal);
      expect(oldSignal?.aborted).toBe(false);

      act(() =>
        root.render(
          scoped(dialog, {
            userId: "user-2",
            tenantId: "tenant-2",
            canWriteCampaigns: true,
          }),
        ),
      );
      await flush();

      expect(oldSignal?.aborted).toBe(true);
      expect(mocks.getDesign).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain("Saved snapshot");
    } finally {
      act(() => root.unmount());
    }
  });

  it("automatically reconciles an ambiguous archive with its exact key after remount", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());
    mocks.archive
      .mockRejectedValueOnce(new Error("Connection closed before response"))
      .mockResolvedValue({
        ...readyDesign(),
        status: "archived",
      });

    const firstRoot = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Make it mine"),
      )!,
    );
    await flush();
    enterValue(
      document.querySelector("#adapt-brief-reference-1") as HTMLTextAreaElement,
      "A weekly launch digest for founders.",
    );
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Create adaptation"),
      )!,
    );
    await flush();
    await flush();
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Discard this design"),
      )!,
    );
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Discard design"),
      )!,
    );
    await flush();

    const firstArchiveOptions = mocks.archive.mock.calls[0]?.[1] as {
      idempotencyKey: string;
    };
    expect(mocks.archive).toHaveBeenCalledWith(
      "design-1",
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );

    act(() => firstRoot.unmount());

    const secondRoot = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );
    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      await flush();
      await flush();

      expect(mocks.archive).toHaveBeenCalledTimes(2);
      expect(mocks.archive.mock.calls[1]?.[1]).toEqual(
        expect.objectContaining({
          idempotencyKey: firstArchiveOptions.idempotencyKey,
        }),
      );
      expect(document.body.textContent).not.toContain("Version 1 · Saved snapshot");
      expect(
        readCampaignTemplateDesignSession(
          RECOVERY_SCOPE,
          "adapt",
          "reference-1",
        )?.pendingArchiveKeys,
      ).toBeUndefined();
    } finally {
      act(() => secondRoot.unmount());
    }
  });

  it("refines from the explicit immutable base revision", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());
    mocks.refine.mockResolvedValue(secondRevisionDesign());

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A weekly launch digest for founders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();
      await flush();

      enterValue(
        document.querySelector(
          "#design-refine-design-1",
        ) as HTMLTextAreaElement,
        "Make the hero shorter.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make another version"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.refine).toHaveBeenCalledWith(
        "design-1",
        {
          instructions: "Make the hero shorter.",
          base_revision: 1,
        },
        expect.objectContaining({
          idempotencyKey: expect.any(String),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain("Version 2 · Saved snapshot");
      expect(
        (
          document.querySelector(
            "#design-refine-design-1",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("");
    } finally {
      act(() => root.unmount());
    }
  });

  it("preserves refinement instructions when the mutation is rejected", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());
    mocks.refine.mockRejectedValue(
      new ApiError("Revision changed elsewhere", 409, undefined, {
        code: "design_revision_conflict",
        kind: "http",
      }),
    );

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A weekly launch digest for founders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();
      await flush();

      const refinement = document.querySelector(
        "#design-refine-design-1",
      ) as HTMLTextAreaElement;
      enterValue(refinement, "Keep my carefully written refinement.");
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make another version"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.refine).toHaveBeenCalledOnce();
      expect(
        (
          document.querySelector(
            "#design-refine-design-1",
          ) as HTMLTextAreaElement
        ).value,
      ).toBe("Keep my carefully written refinement.");
      expect(document.body.textContent).toContain(
        "The design changed in another window",
      );

      click(
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Close",
        )!,
      );
      expect(document.body.textContent).not.toContain(
        "Leave before Moosewave confirms?",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("reconciles an ambiguous refinement with the exact persisted request and key", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());
    mocks.refine
      .mockRejectedValueOnce(
        new ApiError("Generator gateway unavailable", 503, undefined, {
          code: "upstream_unavailable",
          kind: "http",
        }),
      )
      .mockResolvedValueOnce(secondRevisionDesign());

    const dialog = createElement(AdaptTemplateDialog, {
      template: reference(),
      label: "Make it mine",
    });
    const firstRoot = render(dialog);

    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Make it mine"),
      )!,
    );
    await flush();
    enterValue(
      document.querySelector("#adapt-brief-reference-1") as HTMLTextAreaElement,
      "A weekly launch digest for founders.",
    );
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Create adaptation"),
      )!,
    );
    await flush();
    await flush();

    enterValue(
      document.querySelector("#design-refine-design-1") as HTMLTextAreaElement,
      "Keep this exact refinement direction.",
    );
    click(
      Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Make another version"),
      )!,
    );
    await flush();
    await flush();

    const firstRequest = mocks.refine.mock.calls[0]!;
    const firstKey = (firstRequest[2] as { idempotencyKey: string })
      .idempotencyKey;
    expect(
      readCampaignTemplateDesignSession(RECOVERY_SCOPE, "adapt", "reference-1")
        ?.pendingMutations,
    ).toEqual([
      expect.objectContaining({
        operation: "refine",
        idempotencyKey: firstKey,
        payload: {
          instructions: "Keep this exact refinement direction.",
          base_revision: 1,
        },
      }),
    ]);
    act(() => firstRoot.unmount());

    mocks.getDesign
      .mockResolvedValueOnce(readyDesign())
      .mockResolvedValueOnce(secondRevisionDesign());
    const secondRoot = render(dialog);
    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      await flush();
      await flush();

      expect(mocks.refine).toHaveBeenCalledTimes(2);
      expect(mocks.refine.mock.calls[1]).toEqual([
        "design-1",
        {
          instructions: "Keep this exact refinement direction.",
          base_revision: 1,
        },
        expect.objectContaining({ idempotencyKey: firstKey }),
      ]);
      expect(
        readCampaignTemplateDesignSession(
          RECOVERY_SCOPE,
          "adapt",
          "reference-1",
        )?.pendingMutations,
      ).toBeUndefined();
    } finally {
      act(() => secondRoot.unmount());
    }
  });

  it("offers a server-authorized retry for a terminal failure", async () => {
    mocks.createDesign.mockResolvedValue(failedDesign());
    mocks.retry.mockResolvedValue(readyDesign());

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A weekly launch digest for founders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();
      await flush();

      expect(document.body.textContent).toContain("Design attempt failed");
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Retry attempt"),
        )!,
      );
      await flush();
      await flush();

      expect(mocks.retry).toHaveBeenCalledWith(
        "design-1",
        expect.objectContaining({
          idempotencyKey: expect.any(String),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the reviewed revision available when exact-hash saving fails", async () => {
    mocks.createDesign.mockResolvedValue(readyDesign());
    mocks.save.mockRejectedValue(new Error("Name is already in use"));

    const root = render(
      createElement(AdaptTemplateDialog, {
        template: reference(),
        label: "Make it mine",
      }),
    );

    try {
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Make it mine"),
        )!,
      );
      await flush();
      enterValue(
        document.querySelector(
          "#adapt-brief-reference-1",
        ) as HTMLTextAreaElement,
        "A weekly launch digest for founders.",
      );
      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Create adaptation"),
        )!,
      );
      await flush();
      await flush();

      click(
        Array.from(document.querySelectorAll("button")).find((button) =>
          button.textContent?.includes("Save this version"),
        )!,
      );
      await flush();

      expect(mocks.save).toHaveBeenCalledWith(
        "design-1",
        expect.objectContaining({
          revision: 1,
          output_hash: "a".repeat(64),
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
      expect(JSON.stringify(mocks.save.mock.calls[0][1])).not.toContain(
        "body_html",
      );
      expect(document.body.textContent).toContain("Name is already in use");
      expect(document.body.textContent).toContain("Version 1 · Saved snapshot");
    } finally {
      act(() => root.unmount());
    }
  });
});
