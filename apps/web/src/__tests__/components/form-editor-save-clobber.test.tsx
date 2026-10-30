// @vitest-environment happy-dom
//
// Saving a form used to write the server echo straight back into the draft:
//   setForm(updated); setDirty(false);
// Anything the operator typed while the request was in flight was overwritten
// by the older payload the server had just acknowledged, and clearing the
// dirty flag disarmed the unsaved-changes guard, so the loss was silent.
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";
import { importBeforeTests, waitFor } from "../pages/_wait";

import FormEditorPage from "@/app/(dashboard)/app/forms/[id]/page";
import { whoamiFresh } from "@/lib/auth-api";
import { getForm, updateForm } from "@/lib/forms-api";
import type { Form } from "@/lib/forms-types";

const FORM = {
  id: "form_1",
  name: "Newsletter",
  slug: "newsletter",
  optInMode: "single",
  status: "draft",
  structure: { fields: [] },
  settings: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
} as unknown as Form;

let releaseUpdate: ((f: Form) => void) | null = null;

vi.mock("@/lib/forms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/forms-api")>();
  return {
    ...actual,
    getForm: vi.fn(),
    updateForm: vi.fn(),
  };
});

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  whoami: vi.fn().mockResolvedValue({
    user_id: "u1",
    tenant_id: "t1",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
  }),
  whoamiFresh: vi.fn().mockResolvedValue({
    user_id: "u1",
    tenant_id: "t1",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
  }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "form_1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/forms/form_1",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/use-unsaved-changes-guard", () => ({
  useUnsavedChangesGuard: vi.fn(),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  releaseUpdate = null;
  vi.clearAllMocks();
});

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("form editor save clobber", () => {
  // save() loads the forms-types validators through a dynamic import before
  // the identity check and the request. Import that chunk in a hook, on the
  // cold-import timeout, so each test's wait only covers the save itself.
  importBeforeTests(() => import("@/lib/forms-types"));

  it("keeps edits made while the save was in flight", async () => {
    vi.mocked(getForm).mockResolvedValue(FORM);
    vi.mocked(updateForm).mockImplementation(
      () =>
        new Promise<Form>((resolve) => {
          releaseUpdate = resolve;
        }),
    );

    const host = document.createElement("div");
    document.body.append(host);
    const root = trackRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FormEditorPage),
        ),
      );
    });
    await flush();

    const nameInput = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    ).find((i) => i.value === "Newsletter");
    expect(nameInput).toBeTruthy();

    // First edit, then save.
    await act(async () => setValue(nameInput!, "Newsletter v2"));
    const saveButton = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save",
    );
    expect(saveButton).toBeTruthy();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() =>
      expect(vi.mocked(updateForm).mock.calls.length).toBeGreaterThan(0),
    );
    await flush(2);
    expect(vi.mocked(updateForm)).toHaveBeenCalledTimes(1);

    // The operator keeps typing while the request is still open.
    await act(async () => setValue(nameInput!, "Newsletter v3"));

    // The server acknowledges the v2 payload it actually received.
    await act(async () => {
      releaseUpdate!({ ...FORM, name: "Newsletter v2" });
    });
    await flush(4);

    // v3 must survive — the echo of v2 must not overwrite it.
    const values = Array.from(
      document.querySelectorAll<HTMLInputElement>("input"),
    ).map((i) => i.value);
    expect(values).toContain("Newsletter v3");
    expect(values).not.toContain("Newsletter v2");
  });

  it("blocks a save when fresh form-write authority was demoted", async () => {
    vi.mocked(getForm).mockResolvedValue(FORM);
    vi.mocked(whoamiFresh).mockResolvedValueOnce({
      user_id: "u1",
      tenant_id: "t1",
      role: "viewer",
      effective_role: "viewer",
      viewer_mode: false,
    } as never);

    const host = document.createElement("div");
    document.body.append(host);
    const root = trackRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(FormEditorPage),
        ),
      );
    });
    await flush();

    const nameInput = Array.from(
      host.querySelectorAll<HTMLInputElement>("input"),
    ).find((input) => input.value === "Newsletter");
    await act(async () => setValue(nameInput!, "Newsletter blocked"));
    const saveButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save",
    );
    await act(async () => saveButton?.click());
    await waitFor(() =>
      expect(vi.mocked(whoamiFresh).mock.calls.length).toBeGreaterThan(0),
    );
    await flush(2);

    expect(vi.mocked(whoamiFresh)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateForm)).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
