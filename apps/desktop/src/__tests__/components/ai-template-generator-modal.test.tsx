// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  brandProfile: vi.fn(),
  clearCreateAttempt: vi.fn(),
  clearPendingMutation: vi.fn(),
  clearResume: vi.fn(),
  create: vi.fn(),
  createCampaign: vi.fn(),
  getDesign: vi.fn(),
  getTemplate: vi.fn(),
  listDesigns: vi.fn(),
  onCampaignCreated: vi.fn(),
  onClose: vi.fn(),
  onOpenCampaigns: vi.fn(),
  onSaved: vi.fn(),
  poll: vi.fn(),
  readCreateAttempt: vi.fn(),
  readPendingMutation: vi.fn(),
  readResume: vi.fn(),
  refine: vi.fn(),
  retry: vi.fn(),
  revisions: vi.fn(),
  save: vi.fn(),
  prepareMutation: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  writeCreateAttempt: vi.fn(),
  writeResume: vi.fn(),
  modalProps: null as null | Record<string, unknown>,
}));

vi.mock("../../lib/campaign-template-design-mutation-recovery", () => ({
  clearCampaignTemplateDesignPendingMutation: mocks.clearPendingMutation,
  prepareCampaignTemplateDesignMutation: mocks.prepareMutation,
  readCampaignTemplateDesignPendingMutation: mocks.readPendingMutation,
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getBrandVoiceProfile: mocks.brandProfile,
    getCampaignTemplate: mocks.getTemplate,
  },
}));

vi.mock("../../lib/api/campaign-template-designs", () => ({
  campaignTemplateDesignsApi: {
    archive: mocks.archive,
    create: mocks.create,
    createCampaign: mocks.createCampaign,
    get: mocks.getDesign,
    list: mocks.listDesigns,
    refine: mocks.refine,
    retry: mocks.retry,
    revisions: mocks.revisions,
    save: mocks.save,
  },
  clearCampaignTemplateDesignCreateAttempt: mocks.clearCreateAttempt,
  clearCampaignTemplateDesignResume: mocks.clearResume,
  isCampaignTemplateDesignActive: (status: string) =>
    status === "queued" || status === "generating",
  pollCampaignTemplateDesign: mocks.poll,
  readCampaignTemplateDesignCreateAttempt: mocks.readCreateAttempt,
  readCampaignTemplateDesignResume: mocks.readResume,
  writeCampaignTemplateDesignCreateAttempt: mocks.writeCreateAttempt,
  writeCampaignTemplateDesignResume: mocks.writeResume,
}));

vi.mock("../../components/TemplatePreview", () => ({
  TemplatePreview: ({ html }: { html: string }) => (
    <div data-testid="safe-preview">{html}</div>
  ),
  TemplatePreviewToolbar: ({
    onDeviceChange,
  }: {
    onDeviceChange: (device: "desktop" | "mobile") => void;
  }) => (
    <div data-testid="preview-toolbar">
      <button type="button" onClick={() => onDeviceChange("desktop")}>
        Desktop
      </button>
      <button type="button" onClick={() => onDeviceChange("mobile")}>
        Mobile
      </button>
    </div>
  ),
}));

vi.mock("../../lib/campaign-template-previews", () => ({
  campaignTemplatePreviewUrl: (template: CampaignTemplate) =>
    template.preview_assets?.[0]?.url ?? null,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: vi.fn(),
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));

vi.mock("../../components/Modal", () => ({
  Modal: (props: {
    open: boolean;
    onClose: () => void;
    closeDisabled?: boolean;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    children: React.ReactNode;
  }) => {
    mocks.modalProps = props as unknown as Record<string, unknown>;
    return props.open ? (
      <section role="dialog" aria-label="AI template modal">
        <button
          type="button"
          aria-label="Close AI template modal"
          disabled={props.closeDisabled}
          onClick={props.onClose}
        >
          Close
        </button>
        {props.children}
      </section>
    ) : null;
  },
  ModalFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: (props: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
    onClose: () => void;
  }) =>
    props.open ? (
      <section role="alertdialog" aria-label={props.title}>
        <button type="button" onClick={props.onClose}>
          Keep editing
        </button>
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel}
        </button>
      </section>
    ) : null,
}));

import type { CampaignTemplate } from "../../lib/api-client";
import { AiTemplateGeneratorModal } from "../../components/templates/AiTemplateGeneratorModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const HASH_ONE = "a".repeat(64);
const HASH_TWO = "b".repeat(64);

function output(
  name = "Generated launch",
  subject = "A careful launch",
  body = "<h1>Hello {{first_name}}</h1>",
) {
  return {
    name,
    subject,
    preview_text: "Preview copy",
    body_html: body,
    variables: { first_name: "Ada" },
    unresolved_variables: ["company"],
    reference_template_ids: [],
    warnings: ["Review the offer expiry before sending."],
  };
}

function revision(
  number = 1,
  nextOutput = output(),
  hash = number === 1 ? HASH_ONE : HASH_TWO,
) {
  return {
    id: `revision-${number}`,
    draft_id: "design-1",
    revision: number,
    operation: number === 1 ? "initial" : "refine",
    ...(number > 1 ? { base_revision: number - 1 } : {}),
    output: nextOutput,
    output_hash: hash,
    validation: {
      status: "warn",
      checks: [
        {
          code: "active_content",
          status: "pass",
          message: "No active browser content was found.",
        },
        {
          code: "image_alt_text",
          status: "warn",
          message: "One image still needs useful alt text.",
          repaired: false,
        },
      ],
    },
    warnings: [
      {
        code: "mobile_preview_recommended",
        message: "Check the simulated mobile preview before using this design.",
      },
    ],
    created_at: `2026-07-${String(number).padStart(2, "0")}T00:00:00Z`,
  };
}

function design(
  status:
    | "queued"
    | "generating"
    | "ready"
    | "failed"
    | "saved"
    | "campaign_created"
    | "archived" = "ready",
  currentRevision = revision(),
) {
  const ready = status === "ready";
  return {
    id: "design-1",
    mode: "generate",
    status,
    reference_template_ids: [],
    current_revision: currentRevision.revision,
    revision: currentRevision,
    attempt_count: 1,
    ...(status === "failed"
      ? {
          last_error_code: "generator_unavailable",
          last_error_message:
            "The design generator was temporarily unavailable.",
        }
      : {}),
    capabilities: {
      can_refine: ready,
      can_retry: status === "failed",
      can_save: ready,
      can_create_campaign: ready,
      can_archive: status !== "generating" && status !== "archived",
    },
    recommended_action:
      status === "failed"
        ? "retry_campaign_template_design"
        : ready
          ? "review_campaign_template_design"
          : "poll_campaign_template_design",
    retry_after_seconds: status === "queued" ? 2 : undefined,
    expires_at: "2026-08-20T00:00:00Z",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
    request: { mode: "generate", brief: "A launch newsletter" },
  };
}

function designSummary(id = "design-1") {
  const ready = design();
  return {
    id,
    mode: ready.mode,
    status: "ready" as const,
    current_revision: ready.current_revision,
    attempt_count: ready.attempt_count,
    capabilities: ready.capabilities,
    recommended_action: "review_campaign_template_design",
    expires_at: ready.expires_at,
    created_at: ready.created_at,
    updated_at: ready.updated_at,
  };
}

const sourceCapabilities = {
  can_preview: true,
  can_favorite: true,
  can_adapt: true,
  can_use_directly: false,
  can_create_campaign: false,
  can_edit_directly: false,
  can_clone: false,
  can_delete: false,
  can_archive: false,
  can_restore: false,
  has_source_html: false,
  has_source_mjml: false,
  has_desktop_preview: true,
  has_mobile_preview: true,
};

const adaptationSource: CampaignTemplate = {
  id: "reference-1",
  tenant_id: "tenant-1",
  slug: "source-newsletter",
  name: "Source newsletter",
  subject: "The original subject",
  template_kind: "reference",
  review_status: "approved",
  source_license_status: "personal-use-unreviewed",
  source_provider: "external-catalog",
  source_brand: "Example Studio",
  style: "editorial",
  layout: "single-column",
  capabilities: sourceCapabilities,
  warnings: [
    {
      code: "adaptation_only",
      message: "This reference is adaptation-only.",
      recommended_action: "campaign_template_adapt",
    },
  ],
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.modalProps = null;
  mocks.brandProfile.mockResolvedValue({
    data: {
      id: "brand-profile-1",
      descriptors: ["warm", "plain-spoken"],
      writing_rules: ["Avoid jargon"],
      sample_snippets: ["A useful sample."],
      is_active: true,
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-01T00:00:00Z",
    },
  });
  mocks.readResume.mockReturnValue(null);
  mocks.readCreateAttempt.mockReturnValue(null);
  mocks.readPendingMutation.mockResolvedValue({ state: "empty" });
  mocks.listDesigns.mockResolvedValue({ data: { items: [] } });
  mocks.clearCreateAttempt.mockReturnValue(true);
  mocks.prepareMutation.mockImplementation(
    async (
      _scope: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => ({
      ok: true,
      mutation: {
        operation,
        fingerprint: `template-mutation:sha256:${"a".repeat(64)}`,
        payload,
        key: "durable-design-mutation-key",
        createdAt: "2026-07-30T00:00:00Z",
      },
      reused: false,
    }),
  );
  mocks.clearPendingMutation.mockResolvedValue(true);
  mocks.writeResume.mockReturnValue(true);
  mocks.writeCreateAttempt.mockImplementation(
    (
      _scope: string,
      input: Record<string, unknown>,
      idempotencyKey: string,
    ) => ({
      input,
      serializedInput: JSON.stringify(input),
      idempotencyKey,
      createdAt: "2026-07-30T00:00:00Z",
    }),
  );
  mocks.create.mockResolvedValue({ data: design() });
  mocks.revisions.mockResolvedValue({ data: { items: [revision()] } });
  mocks.save.mockResolvedValue({
    data: {
      id: "created-template",
      slug: "generated-launch",
      name: "Generated launch",
      subject: "A careful launch",
      capabilities: sourceCapabilities,
      warnings: [],
    },
  });
  mocks.createCampaign.mockResolvedValue({
    data: {
      id: "created-campaign",
      name: "Generated launch",
      status: "draft",
    },
  });
  mocks.archive.mockResolvedValue({ data: design("archived") });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(
  adaptSource: CampaignTemplate | null = null,
  open = true,
): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() =>
    root?.render(
      <AiTemplateGeneratorModal
        open={open}
        onClose={mocks.onClose}
        adaptSource={adaptSource}
        workspaceScope="tenant-1:user-1"
        onSaved={mocks.onSaved}
        onCampaignCreated={mocks.onCampaignCreated}
        onOpenCampaigns={mocks.onOpenCampaigns}
      />,
    ),
  );
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) {
      await Promise.resolve();
    }
  });
}

async function generate(): Promise<void> {
  const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
  if (!brief) throw new Error("Missing brief field");
  setValue(brief, "A detailed monthly product launch email");
  act(() => button("Generate draft").click());
  await flush();
}

describe("durable AI template design lifecycle", () => {
  it("creates a durable job, surfaces server validation, and saves only the exact revision/hash", async () => {
    render();
    await flush();
    await generate();

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "generate",
        brief: expect.stringContaining("monthly product launch"),
        fidelity: "inspired",
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).toContain("Server validation · warn");
    expect(document.body.textContent).toContain(
      "No active browser content was found.",
    );
    expect(document.body.textContent).toContain(
      "Check the simulated mobile preview",
    );

    act(() => button("Save as template").click());
    await flush();

    expect(mocks.save).toHaveBeenCalledWith(
      "design-1",
      {
        revision: 1,
        output_hash: HASH_ONE,
        slug: "generated-launch-design-1",
        name: "Generated launch",
        subject: "A careful launch",
        preview_text: "Preview copy",
      },
      { idempotencyKey: expect.any(String) },
    );
    const commit = mocks.save.mock.calls[0]?.[1];
    expect(commit).not.toHaveProperty("body_html");
    expect(commit).not.toHaveProperty("body_mjml");
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(button("Use in campaign").disabled).toBe(false);
    act(() => button("Use in campaign").click());
    await flush();
    expect(mocks.createCampaign).toHaveBeenCalledWith(
      "design-1",
      expect.objectContaining({
        revision: 1,
        output_hash: HASH_ONE,
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).toContain(
      "and a campaign draft now point to this exact immutable design revision",
    );

    act(() => button("Open saved template").click());
    await flush();
    expect(mocks.onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "created-template" }),
    );
    expect(mocks.clearResume).toHaveBeenCalledWith(
      "tenant-1:user-1",
      "design-1",
    );
  });

  it("reuses the exact save idempotency key after an ambiguous response", async () => {
    mocks.save.mockRejectedValueOnce(new Error("response lost"));
    render();
    await flush();
    await generate();

    act(() => button("Save as template").click());
    await flush();
    expect(document.body.textContent).toContain(
      "The finish request did not complete",
    );

    act(() => button("Save as template").click());
    await flush();

    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[0]?.[2]?.idempotencyKey).toBe(
      mocks.save.mock.calls[1]?.[2]?.idempotencyKey,
    );
    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(button("Open saved template").disabled).toBe(false);
  });

  it("does not overwrite operator edits when revision history arrives late", async () => {
    let resolveHistory!: (value: {
      data: { items: ReturnType<typeof revision>[] };
    }) => void;
    mocks.revisions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );
    render();
    await flush();
    await generate();

    const subject = document.querySelector<HTMLInputElement>("#tpl-ai-subject");
    if (!subject) throw new Error("Missing subject field");
    setValue(subject, "Operator-edited subject");

    await act(async () => {
      resolveHistory({ data: { items: [revision()] } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(subject.value).toBe("Operator-edited subject");
    expect(document.body.textContent).toContain("Server revision history");
  });

  it("keeps the verified current hash when revision history disagrees", async () => {
    mocks.revisions.mockResolvedValueOnce({
      data: {
        items: [revision(1, output(), HASH_TWO)],
      },
    });
    render();
    await flush();
    await generate();

    expect(document.body.textContent).toContain(
      "revision history disagrees with the exact revision",
    );
    act(() => button("Save as template").click());
    await flush();

    expect(mocks.save).toHaveBeenCalledWith(
      "design-1",
      expect.objectContaining({ revision: 1, output_hash: HASH_ONE }),
      { idempotencyKey: expect.any(String) },
    );
  });

  it("reuses one idempotency key when the create acknowledgement is ambiguous", async () => {
    mocks.create
      .mockRejectedValueOnce(new Error("connection dropped"))
      .mockResolvedValueOnce({ data: design() });
    render();
    await flush();
    await generate();
    expect(document.body.textContent).toContain(
      "server did not acknowledge the design request",
    );

    act(() => button("Generate draft").click());
    await flush();

    const firstKey = mocks.create.mock.calls[0]?.[1]?.idempotencyKey;
    const secondKey = mocks.create.mock.calls[1]?.[1]?.idempotencyKey;
    expect(firstKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondKey).toBe(firstKey);
    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-subject")?.value,
    ).toBe("A careful launch");
  });

  it("serializes same-tick create intent before the durable write resolves", async () => {
    let releaseCheckpoint = (): void => undefined;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    mocks.writeCreateAttempt.mockImplementationOnce(
      async (
        _scope: string,
        input: Record<string, unknown>,
        idempotencyKey: string,
      ) => {
        await checkpointGate;
        return {
          input,
          serializedInput: JSON.stringify(input),
          idempotencyKey,
          createdAt: "2026-07-30T00:00:00Z",
        };
      },
    );
    render();
    await flush();
    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    if (!brief) throw new Error("Missing brief field");
    setValue(brief, "A detailed monthly product launch email");

    act(() => {
      const trigger = button("Generate draft");
      trigger.click();
      trigger.click();
    });
    await flush();

    expect(mocks.writeCreateAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();

    releaseCheckpoint();
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("retires a known-offline create checkpoint without replaying it", async () => {
    mocks.create.mockResolvedValueOnce({
      error: {
        message: "A live connection is required.",
        code: "offline",
        kind: "network",
      },
      retryability: "after-reconnect",
    });
    render();
    await flush();
    await generate();

    const firstKey = mocks.create.mock.calls[0]?.[1]?.idempotencyKey;
    expect(mocks.clearCreateAttempt).toHaveBeenCalledWith(
      "tenant-1:user-1",
      firstKey,
    );
    expect(document.body.textContent).not.toContain(
      "Unfinished design request found",
    );

    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    if (!brief) throw new Error("Missing brief field");
    setValue(brief, "A different direction after reconnecting");
    act(() => button("Generate draft").click());
    await flush();

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1]?.[1]?.idempotencyKey).not.toBe(firstKey);
  });

  it("retains an explicitly ambiguous 409 checkpoint for exact-key recovery", async () => {
    mocks.create.mockResolvedValueOnce({
      error: {
        message: "The earlier mutation outcome is ambiguous.",
        status: 409,
        code: "design_mutation_replay_ambiguous",
      },
      retryability: "not-retryable",
    });
    render();
    await flush();
    await generate();

    expect(mocks.clearCreateAttempt).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Unfinished design request found",
    );
    expect(button("Resume exact request").disabled).toBe(false);
  });

  it("does not dispatch create when its durable checkpoint is unavailable", async () => {
    mocks.writeCreateAttempt.mockReturnValueOnce(null);
    render();
    await flush();
    await generate();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Recovery storage is unavailable. No design request was sent",
    );
    expect(mocks.modalProps?.closeDisabled).toBe(false);
  });

  it("requires confirmation before resuming a persisted pending create", async () => {
    mocks.create.mockRejectedValueOnce(new Error("acknowledgement lost"));
    render();
    await flush();
    await generate();

    const firstInput = mocks.create.mock.calls[0]?.[0];
    const firstKey = mocks.create.mock.calls[0]?.[1]?.idempotencyKey;
    expect(mocks.writeCreateAttempt).toHaveBeenCalledWith(
      "tenant-1:user-1",
      firstInput,
      firstKey,
    );

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;

    mocks.readCreateAttempt.mockReturnValueOnce({
      input: firstInput,
      serializedInput: JSON.stringify(firstInput),
      idempotencyKey: firstKey,
      createdAt: "2026-07-29T00:00:00Z",
    });
    mocks.create.mockResolvedValueOnce({ data: design() });
    render();
    await flush(12);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Unfinished design request found",
    );
    expect(document.body.textContent).toContain(
      "instead of replaying it in the background",
    );

    act(() => button("Resume exact request").click());
    await flush(12);

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1]).toEqual([
      firstInput,
      { idempotencyKey: firstKey },
    ]);
    expect(mocks.clearCreateAttempt).toHaveBeenCalledWith(
      "tenant-1:user-1",
      firstKey,
    );
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Your exact pending template design request was safely resumed.",
    );
  });

  it("can discard a cold pending create without dispatching it", async () => {
    const pending = {
      input: {
        mode: "generate" as const,
        brief: "A request that needs an explicit decision",
      },
      serializedInput: JSON.stringify({
        mode: "generate",
        brief: "A request that needs an explicit decision",
      }),
      idempotencyKey: "cold-create-key",
      createdAt: "2026-07-29T00:00:00Z",
    };
    mocks.readCreateAttempt.mockReturnValueOnce(pending);
    render();
    await flush(12);

    expect(mocks.create).not.toHaveBeenCalled();
    act(() => button("Discard checkpoint").click());
    await flush();

    expect(mocks.clearCreateAttempt).toHaveBeenCalledWith(
      "tenant-1:user-1",
      "cold-create-key",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "Unfinished design request found",
    );
  });

  it("keeps an unfinished create visible when checkpoint deletion fails", async () => {
    mocks.readCreateAttempt.mockReturnValueOnce({
      input: { mode: "generate", brief: "Do not lose this request" },
      serializedInput: JSON.stringify({
        mode: "generate",
        brief: "Do not lose this request",
      }),
      idempotencyKey: "cold-create-key",
      createdAt: "2026-07-29T00:00:00Z",
    });
    mocks.clearCreateAttempt.mockReturnValueOnce(false);
    render();
    await flush(12);

    act(() => button("Discard checkpoint").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Unfinished design request found",
    );
    expect(document.body.textContent).toContain(
      "checkpoint could not be discarded",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("uses server adaptation capability and preserves the guided comparison/mobile flow", async () => {
    const adapted = {
      ...design(),
      mode: "adapt",
      source_template_id: "reference-1",
      request: { mode: "adapt", source_template_id: "reference-1" },
    };
    mocks.create.mockResolvedValueOnce({ data: adapted });
    render(adaptationSource);
    await flush();

    expect(document.body.textContent).toContain(
      "server confirms a hosted visual preview",
    );
    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    const audience =
      document.querySelector<HTMLInputElement>("#tpl-ai-audience");
    const sections =
      document.querySelector<HTMLTextAreaElement>("#tpl-ai-sections");
    const cta = document.querySelector<HTMLInputElement>("#tpl-ai-cta");
    if (!brief || !audience || !sections || !cta) {
      throw new Error("Missing Make it mine direction fields");
    }
    setValue(brief, "Turn this into our July customer newsletter.");
    setValue(audience, "Existing starter-plan customers");
    setValue(sections, "Opening note\nThree product updates\nCustomer story");
    setValue(cta, "Explore the July release");
    act(() =>
      document
        .querySelector<HTMLInputElement>(
          'input[name="tpl-ai-fidelity"][value="layout"]',
        )
        ?.click(),
    );
    act(() => button("Create my version").click());
    await flush();

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "adapt",
        source_template_id: "reference-1",
        fidelity: "close",
        audience: "Existing starter-plan customers",
        sections: ["Opening note", "Three product updates", "Customer story"],
        cta: "Explore the July release",
        brand: {
          descriptors: ["warm", "plain-spoken"],
          writing_rules: ["Avoid jargon"],
          sample_snippets: ["A useful sample."],
        },
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).toContain("Original inspiration");
    expect(document.body.textContent).toContain("Editable result");
    expect(document.body.textContent).toContain("Metadata comparison only");
    act(() => button("Mobile").click());
    expect(document.body.textContent).toContain(
      "Mobile is a simulated 375px preview",
    );
  });

  it("shows a trusted hosted capture for screenshot-only inspiration", async () => {
    const screenshotSource: CampaignTemplate = {
      ...adaptationSource,
      preview_assets: [
        {
          variant: "desktop",
          url: "https://assets.postwave.test/hosted/source.png",
          mime_type: "image/png",
          width: 1200,
          height: 2400,
          size_bytes: 80_000,
          status: "ready",
        },
      ],
    };
    render(screenshotSource);
    await flush();
    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    if (!brief) throw new Error("Missing adaptation direction");
    setValue(brief, "Turn this into our July customer newsletter.");
    act(() => button("Create my version").click());
    await flush();

    const image = document.querySelector<HTMLImageElement>(
      'img[alt="Hosted desktop preview of Source newsletter"]',
    );
    expect(image?.src).toBe("https://assets.postwave.test/hosted/source.png");
    expect(document.body.textContent).toContain(
      "The provider page is never loaded",
    );
  });

  it("refines from an explicit base and keeps immutable server history", async () => {
    const secondRevision = revision(
      2,
      output("Version two", "Second subject", "<h1>Second version</h1>"),
    );
    mocks.revisions
      .mockResolvedValueOnce({ data: { items: [revision()] } })
      .mockResolvedValue({ data: { items: [secondRevision, revision()] } });
    mocks.refine.mockResolvedValueOnce({
      data: design("ready", secondRevision),
    });
    render();
    await flush();
    await generate();

    const refinement =
      document.querySelector<HTMLTextAreaElement>("#tpl-ai-refinement");
    if (!refinement) throw new Error("Missing refinement field");
    setValue(refinement, "Shorten the opening and strengthen the CTA.");
    act(() => button("Try another version").click());
    await flush(20);

    expect(mocks.refine).toHaveBeenCalledWith(
      "design-1",
      {
        instructions: "Shorten the opening and strengthen the CTA.",
        base_revision: 1,
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-subject")?.value,
    ).toBe("Second subject");
    expect(document.body.textContent).toContain("Server revision history");

    act(() => button("View version 1").click());
    expect(document.body.textContent).toContain("Viewing immutable version 1");
    expect(button("Viewing version 1").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(button("Save as template").disabled).toBe(true);
    act(() => button("View version 2").click());
    expect(button("Viewing version 2").getAttribute("aria-pressed")).toBe(
      "true",
    );
    button("Viewing version 2").focus();
    expect(document.activeElement).toBe(button("Viewing version 2"));
    expect(button("Save as template").disabled).toBe(false);
  });

  it("keeps Escape/close blocked only until a resumable design ID is acknowledged", async () => {
    let resolveCreate!: (value: { data: ReturnType<typeof design> }) => void;
    mocks.create.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    mocks.poll.mockReturnValueOnce(new Promise(() => undefined));
    render();
    await flush();
    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    if (!brief) throw new Error("Missing brief field");
    setValue(brief, "A durable monthly newsletter.");
    act(() => button("Generate draft").click());

    expect(mocks.modalProps?.closeDisabled).toBe(true);
    expect(mocks.modalProps?.closeOnEscape).toBe(false);
    expect(button("Close").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>('[aria-live="polite"]'),
      ).some((region) =>
        region.textContent?.includes("Starting a durable design"),
      ),
    ).toBe(true);

    await act(async () => {
      resolveCreate({ data: design("queued") });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.modalProps?.closeDisabled).toBe(false);
    expect(mocks.modalProps?.closeOnEscape).toBe(true);
    expect(button("Close").disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
  });

  it("does not claim reopenability until the resume pointer round-trip succeeds", async () => {
    mocks.writeResume.mockReturnValue(false);
    render();
    await flush();
    await generate();

    expect(document.body.textContent).toContain(
      "Automatic resume is not saved on this device",
    );
    expect(document.body.textContent).toContain("design-1");
    act(() => button("Close").click());
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Design design-1 exists on the server, but automatic reopening is unavailable on this device.",
    );
    expect(mocks.toastInfo).not.toHaveBeenCalledWith(
      "Design saved on the server. Reopen this window to continue.",
    );

    mocks.writeResume.mockReturnValue(true);
    act(() => button("Retry saving resume").click());
    await flush();
    expect(document.body.textContent).not.toContain(
      "Automatic resume is not saved on this device",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Automatic design resume is available on this device.",
    );
  });

  it("lets a queued server job continue after close and cancels only local polling", async () => {
    const queued = {
      ...design("queued"),
      current_revision: 0,
      revision: undefined,
    };
    mocks.create.mockResolvedValueOnce({ data: queued });
    let pollSignal: AbortSignal | undefined;
    mocks.poll.mockImplementation(
      (_id: string, options: { signal?: AbortSignal }): Promise<never> => {
        pollSignal = options.signal;
        return new Promise(() => undefined);
      },
    );
    render();
    await flush();
    await generate();

    expect(mocks.writeResume).toHaveBeenCalledWith(
      "tenant-1:user-1",
      expect.objectContaining({ id: "design-1", status: "queued" }),
    );
    expect(button("Close").disabled).toBe(false);
    act(() => button("Close").click());
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Design saved on the server. Reopen this window to continue.",
    );

    render(null, false);
    expect(pollSignal?.aborted).toBe(true);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("resumes a persisted design without starting a duplicate job", async () => {
    mocks.readResume.mockReturnValueOnce({
      designId: "design-1",
      mode: "generate",
      expiresAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    mocks.getDesign.mockResolvedValueOnce({ data: design() });
    render();
    await flush(12);

    expect(mocks.getDesign).toHaveBeenCalledWith("design-1", {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-subject")?.value,
    ).toBe("A careful launch");
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Your server-backed template design was resumed.",
    );
    expect(mocks.listDesigns).not.toHaveBeenCalled();
  });

  it("offers actor-scoped server recovery when local storage has no pointer", async () => {
    mocks.listDesigns.mockResolvedValueOnce({
      data: { items: [designSummary()] },
    });
    mocks.getDesign.mockResolvedValueOnce({ data: design() });
    render();
    await flush(12);

    expect(mocks.listDesigns).toHaveBeenCalledWith({
      limit: 20,
      signal: expect.any(AbortSignal),
    });
    expect(mocks.getDesign).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "A saved design is ready to reopen",
    );
    const recoveryButton = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((candidate) => candidate.textContent?.includes("Generated · ready"));
    if (!recoveryButton) throw new Error("Missing server recovery choice");
    act(() => recoveryButton.click());
    await flush(12);

    expect(mocks.getDesign).toHaveBeenCalledWith("design-1");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Your server-backed template design was reopened.",
    );
  });

  it("runs a fresh actor-scoped recovery pass every time the modal opens", async () => {
    render();
    await flush(12);
    expect(mocks.listDesigns).toHaveBeenCalledTimes(1);

    render(null, false);
    await flush();
    render();
    await flush(12);

    expect(mocks.listDesigns).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect recovery choices dismissed while an older page is loading", async () => {
    let resolveOlder!: (value: {
      data: { items: ReturnType<typeof designSummary>[] };
    }) => void;
    mocks.listDesigns
      .mockResolvedValueOnce({
        data: { items: [designSummary()], next_cursor: "older-cursor" },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
      );
    render();
    await flush(12);

    act(() => button("Load older designs").click());
    await flush();
    act(() => button("Continue with a new direction").click());
    await flush();
    await act(async () => {
      resolveOlder({ data: { items: [designSummary("design-2")] } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain(
      "saved designs are ready to reopen",
    );
    expect(document.body.textContent).not.toContain(
      "A saved design is ready to reopen",
    );
  });

  it("still offers server inspection when local recovery storage is unavailable", async () => {
    mocks.readPendingMutation.mockResolvedValueOnce({ state: "unavailable" });
    mocks.listDesigns.mockResolvedValueOnce({
      data: { items: [designSummary()] },
    });
    render();
    await flush(12);

    expect(mocks.listDesigns).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Recovery storage is unavailable",
    );
    expect(document.body.textContent).toContain(
      "A saved design is ready to reopen",
    );
  });

  it("prioritizes a pending action over an older local resume pointer", async () => {
    const pending = {
      operation: "save",
      fingerprint: `template-mutation:sha256:${"e".repeat(64)}`,
      payload: {
        design_id: "design-1",
        revision: 1,
        output_hash: HASH_ONE,
      },
      key: "pending-save-key",
      createdAt: "2026-07-30T00:00:00Z",
    };
    mocks.readResume.mockReturnValueOnce({
      designId: "older-design",
      mode: "generate",
      expiresAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    mocks.readPendingMutation.mockResolvedValue({
      state: "ready",
      mutation: pending,
    });
    mocks.getDesign.mockResolvedValueOnce({ data: design() });
    render();
    await flush(16);

    expect(mocks.getDesign).toHaveBeenCalledWith("design-1", {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "A pending action took priority over an older local design pointer. The pending design was reopened for safe reconciliation.",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reconciles an acknowledged action even when the design was later archived", async () => {
    const pending = {
      operation: "save",
      fingerprint: `template-mutation:sha256:${"f".repeat(64)}`,
      payload: {
        design_id: "design-1",
        revision: 1,
        output_hash: HASH_ONE,
      },
      key: "archived-save-key",
      createdAt: "2026-07-30T00:00:00Z",
    };
    mocks.readPendingMutation.mockResolvedValue({
      state: "ready",
      mutation: pending,
    });
    mocks.getDesign.mockResolvedValueOnce({
      data: {
        ...design("archived"),
        saved_template_id: "created-template",
        saved_revision: 1,
      },
    });
    render();
    await flush(16);

    expect(mocks.clearPendingMutation).toHaveBeenCalledWith(
      "tenant-1:user-1",
      pending,
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "saved design session was archived",
    );
  });

  it("recovers an acknowledged save and opens the existing template instead of saving twice", async () => {
    mocks.readResume.mockReturnValueOnce({
      designId: "design-1",
      mode: "generate",
      expiresAt: "2026-08-20T00:00:00Z",
      updatedAt: "2026-07-29T00:00:00Z",
    });
    mocks.getDesign.mockResolvedValueOnce({
      data: {
        ...design("saved"),
        saved_template_id: "created-template",
        saved_revision: 1,
        capabilities: {
          ...design("saved").capabilities,
          can_create_campaign: true,
        },
        recommended_action: "use_saved_campaign_template",
      },
    });
    mocks.getTemplate.mockResolvedValueOnce({
      data: {
        id: "created-template",
        slug: "generated-launch",
        name: "Generated launch",
        subject: "A careful launch",
      },
    });
    render();
    await flush(12);

    expect(button("Open saved template").disabled).toBe(false);
    act(() => button("Open saved template").click());
    await flush();

    expect(mocks.getTemplate).toHaveBeenCalledWith("created-template");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ id: "created-template" }),
    );
    expect(mocks.clearResume).not.toHaveBeenCalledWith(
      "tenant-1:user-1",
      "design-1",
    );
  });

  it("keeps the reviewed design open when a second-action return path cannot be persisted", async () => {
    render();
    await flush();
    await generate();

    act(() => button("Save as template").click());
    await flush();
    mocks.writeResume.mockReturnValue(false);

    act(() => button("Open saved template").click());
    await flush();

    expect(mocks.onSaved).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "could not save the return path for creating a campaign",
    );
    expect(button("Open saved template").disabled).toBe(false);
  });

  it("reconciles and clears an acknowledged pending save on cold resume", async () => {
    const pending = {
      operation: "save",
      fingerprint: `template-mutation:sha256:${"c".repeat(64)}`,
      payload: {
        design_id: "design-1",
        revision: 1,
        output_hash: HASH_ONE,
        name: "Generated launch",
      },
      key: "cold-save-key",
      createdAt: "2026-07-30T00:00:00Z",
    };
    mocks.readPendingMutation.mockResolvedValue({
      state: "ready",
      mutation: pending,
    });
    mocks.getDesign.mockResolvedValueOnce({
      data: {
        ...design("saved"),
        saved_template_id: "created-template",
        saved_revision: 1,
      },
    });
    render();
    await flush(16);

    expect(mocks.getDesign).toHaveBeenCalledWith("design-1", {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.clearPendingMutation).toHaveBeenCalledWith(
      "tenant-1:user-1",
      pending,
    );
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "The server confirmed the previous template save; recovery is complete.",
    );
  });

  it("restores an unresolved save payload and reuses its key after a cold resume", async () => {
    const pending = {
      operation: "save",
      fingerprint: `template-mutation:sha256:${"d".repeat(64)}`,
      payload: {
        design_id: "design-1",
        revision: 1,
        output_hash: HASH_ONE,
        slug: "restored-name-design-1",
        name: "Restored name",
        subject: "Restored subject",
        preview_text: "Restored preview",
      },
      key: "cold-save-key",
      createdAt: "2026-07-30T00:00:00Z",
    };
    mocks.readPendingMutation.mockResolvedValue({
      state: "ready",
      mutation: pending,
    });
    mocks.prepareMutation.mockResolvedValue({
      ok: true,
      mutation: pending,
      reused: true,
    });
    mocks.getDesign.mockResolvedValueOnce({ data: design() });
    render();
    await flush(16);

    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-name")?.value,
    ).toBe("Restored name");
    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-subject")?.value,
    ).toBe("Restored subject");
    act(() => button("Save as template").click());
    await flush();

    expect(mocks.save).toHaveBeenCalledWith(
      "design-1",
      expect.objectContaining({
        name: "Restored name",
        subject: "Restored subject",
        preview_text: "Restored preview",
      }),
      { idempotencyKey: "cold-save-key" },
    );
  });

  it("retries a failed server job and creates a campaign from the exact revision without saving HTML", async () => {
    mocks.create.mockResolvedValueOnce({ data: design("failed") });
    mocks.retry.mockResolvedValueOnce({ data: design() });
    render();
    await flush();
    await generate();

    expect(document.body.textContent).toContain(
      "The design generator was temporarily unavailable.",
    );
    act(() => button("Retry failed job").click());
    await flush();
    expect(mocks.retry).toHaveBeenCalledWith("design-1", {
      idempotencyKey: expect.any(String),
    });

    act(() => button("Use in campaign").click());
    await flush();
    expect(mocks.createCampaign).toHaveBeenCalledWith(
      "design-1",
      {
        revision: 1,
        output_hash: HASH_ONE,
        name: "Generated launch",
        subject: "A careful launch",
        preview_text: "Preview copy",
        variables: { first_name: "Ada", company: "" },
      },
      { idempotencyKey: expect.any(String) },
    );
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.onCampaignCreated).not.toHaveBeenCalled();
    expect(button("Save as template").disabled).toBe(false);

    act(() => button("Save as template").click());
    await flush();
    expect(mocks.save).toHaveBeenCalledWith(
      "design-1",
      expect.objectContaining({
        revision: 1,
        output_hash: HASH_ONE,
      }),
      { idempotencyKey: expect.any(String) },
    );
    expect(document.body.textContent).toContain(
      "and a campaign draft now point to this exact immutable design revision",
    );

    act(() => button("Check Campaigns").click());
    expect(mocks.onCampaignCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: "created-campaign" }),
    );
  });

  it("routes an already-created campaign to inspection instead of duplicating it", async () => {
    mocks.createCampaign.mockResolvedValueOnce({
      error: {
        message: "Campaign already created",
        status: 409,
        code: "design_campaign_already_created",
      },
    });
    mocks.getDesign.mockResolvedValueOnce({
      data: {
        ...design("campaign_created"),
        created_campaign_id: "existing-campaign",
        campaign_revision: 1,
      },
    });
    render();
    await flush();
    await generate();
    act(() => button("Use in campaign").click());
    await flush();

    expect(document.body.textContent).toContain(
      "A campaign already exists for this design",
    );
    expect(mocks.clearPendingMutation).toHaveBeenCalledWith(
      "tenant-1:user-1",
      expect.objectContaining({
        operation: "create-campaign",
        payload: expect.objectContaining({ design_id: "design-1" }),
      }),
    );
    expect(mocks.getDesign).toHaveBeenCalledWith("design-1");
    expect(button("Check Campaigns").disabled).toBe(false);
    act(() => button("Check Campaigns").click());
    expect(mocks.createCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.onOpenCampaigns).toHaveBeenCalledTimes(1);
  });

  it("archives an explicit discard and refreshes safely on revision conflicts", async () => {
    const secondRevision = revision(
      2,
      output("Server version", "Server subject"),
    );
    mocks.save.mockResolvedValueOnce({
      error: {
        message: "Refresh the design",
        status: 409,
        code: "design_revision_conflict",
      },
    });
    mocks.getDesign.mockResolvedValueOnce({
      data: design("ready", secondRevision),
    });
    mocks.revisions.mockResolvedValue({
      data: { items: [secondRevision, revision()] },
    });
    render();
    await flush();
    await generate();
    act(() => button("Save as template").click());
    await flush(12);

    expect(mocks.getDesign).toHaveBeenCalledWith("design-1");
    expect(mocks.clearPendingMutation).toHaveBeenCalledWith(
      "tenant-1:user-1",
      expect.objectContaining({
        operation: "save",
        payload: expect.objectContaining({
          design_id: "design-1",
          revision: 1,
          output_hash: HASH_ONE,
        }),
      }),
    );
    expect(document.body.textContent).toContain(
      "A newer server revision exists",
    );
    expect(
      document.querySelector<HTMLInputElement>("#tpl-ai-subject")?.value,
    ).toBe("Server subject");

    act(() => button("Discard").click());
    expect(
      document.querySelector('[aria-label="Archive this template design?"]'),
    ).not.toBeNull();
    act(() => button("Archive design").click());
    await flush();
    expect(mocks.archive).toHaveBeenCalledWith("design-1", {
      idempotencyKey: expect.any(String),
    });
  });

  it("fails closed when server adaptation capability is absent", async () => {
    render({
      ...adaptationSource,
      capabilities: {
        ...sourceCapabilities,
        can_adapt: false,
      },
      warnings: [
        {
          code: "review_pending",
          message: "This reference is awaiting a rights review.",
        },
      ],
    });
    await flush();
    const brief = document.querySelector<HTMLTextAreaElement>("#tpl-ai-brief");
    if (!brief) throw new Error("Missing brief field");
    setValue(brief, "Adapt this newsletter for July.");
    act(() => button("Create my version").click());
    await flush();

    expect(mocks.create).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("awaiting a rights review");
  });
});
