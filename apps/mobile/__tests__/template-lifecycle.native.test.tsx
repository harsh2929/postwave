/**
 * Archive / restore from the phone — the reversible lifecycle pair
 * (PATCH /campaign-templates/{id}/archive · /restore, editor + strong
 * If-Match), driven end-to-end through the REAL hook, the REAL confirm sheet
 * and the REAL action control, with only the transport and react-query
 * stubbed.
 *
 * WHY THIS FILE STUBS `@tanstack/react-query` ITSELF. The shared mock's
 * `mutateAsync` resolves `{}` without ever calling `mutationFn`, so a suite
 * built on it could pass with `archiveTemplate` never reached — the
 * transport-seam trap. The stand-in here RUNS the mutation function, so the
 * assertion below is about the request that would go out: the id and the
 * detail read's strong tag, verbatim.
 *
 * The pure rules (which verb, whether it is offered, what is confirmed) are
 * vitest-pinned in src/lib/templateLifecycle.test.ts; this file pins the
 * FLOW: confirm-before-archive, no-confirm-before-restore, the failure
 * sentence, and that a refusal keeps the sheet open.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import { parseTemplate, type MobileTemplate } from "@/lib/templateCatalog";

jest.mock("@/api/campaignTemplates", () => ({
  archiveTemplate: jest.fn(async () => null),
  restoreTemplate: jest.fn(async () => null),
}));

jest.mock("@tanstack/react-query", () => {
  const invalidateQueries = jest.fn(async () => undefined);
  return {
    useQueryClient: () => ({ invalidateQueries }),
    useMutation: (options: {
      mutationFn: (vars: unknown) => Promise<unknown>;
      onSuccess?: (result: unknown, vars: unknown, context: unknown) => unknown;
    }) => ({
      isPending: false,
      mutateAsync: async (vars: unknown) => {
        const result = await options.mutationFn(vars);
        await options.onSuccess?.(result, vars, undefined);
        return result;
      },
    }),
  };
});

import * as Api from "@/api/campaignTemplates";

import { TemplateLifecycleAction } from "../src/components/templates/TemplateLifecycleAction";
import { useTemplateLifecycle } from "../src/hooks/useTemplateLifecycle";

const archiveTemplate = jest.mocked(Api.archiveTemplate);
const restoreTemplate = jest.mocked(Api.restoreTemplate);

/** The single read: the only response that carries a strong entity tag. */
const WIRE = {
  id: "tpl-1",
  slug: "spring-launch",
  name: "Spring launch",
  subject: "The spring drop is live",
  body_html: "<p>Hello</p>",
  variables: [],
  tags: [],
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
};
const ACTIVE: MobileTemplate = parseTemplate({ ...WIRE, etag: '"v7"' }, "detail")!;
const ARCHIVED: MobileTemplate = parseTemplate(
  { ...WIRE, etag: '"v8"', archived_at: "2026-08-01T10:00:00Z" },
  "detail",
)!;

function Harness({
  template,
  onSettled,
}: {
  template: MobileTemplate;
  onSettled: () => void;
}) {
  const lifecycle = useTemplateLifecycle(onSettled);
  return (
    <TemplateLifecycleAction
      template={template}
      canWrite
      online
      toggling={lifecycle.pending}
      onToggle={(row) => void lifecycle.toggleArchived(row)}
    />
  );
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  archiveTemplate.mockReset();
  restoreTemplate.mockReset();
  archiveTemplate.mockResolvedValue(null);
  restoreTemplate.mockResolvedValue(null);
});

describe("archiving a design", () => {
  it("asks first — naming the design — and does nothing when declined", async () => {
    const onSettled = jest.fn();
    await render(<Harness template={ACTIVE} onSettled={onSettled} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByLabelText("Archive this design"));
    expect(screen.getByText("Archive “Spring launch”?")).toBeTruthy();
    // The sentence that makes this a reversible act rather than a delete.
    expect(screen.getByText(/Nothing is deleted/)).toBeTruthy();

    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(archiveTemplate).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("PATCHes with the detail read's strong tag, verbatim, once confirmed", async () => {
    const onSettled = jest.fn();
    await render(<Harness template={ACTIVE} onSettled={onSettled} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByLabelText("Archive this design"));
    await fireEvent.press(screen.getByLabelText("Archive"));

    await waitFor(() =>
      expect(archiveTemplate).toHaveBeenCalledWith("tpl-1", '"v7"'),
    );
    expect(restoreTemplate).not.toHaveBeenCalled();
    // The sheet closes, and the toast says where the design went.
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(
      screen.getByText(/Archived Spring launch\. Restore it any time/),
    ).toBeTruthy();
  });

  it("keeps the sheet open and says why when the server refuses", async () => {
    archiveTemplate.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    const onSettled = jest.fn();
    await render(<Harness template={ACTIVE} onSettled={onSettled} />, {
      wrapper,
    });

    await fireEvent.press(screen.getByLabelText("Archive this design"));
    await fireEvent.press(screen.getByLabelText("Archive"));

    await waitFor(() =>
      expect(
        screen.getByText("Your role on this workspace doesn't allow that."),
      ).toBeTruthy(),
    );
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe("restoring a design", () => {
  it("goes straight through — the recoverable half needs no confirmation", async () => {
    const onSettled = jest.fn();
    await render(<Harness template={ARCHIVED} onSettled={onSettled} />, {
      wrapper,
    });

    await fireEvent.press(
      screen.getByLabelText("Restore this design to the library"),
    );

    await waitFor(() =>
      expect(restoreTemplate).toHaveBeenCalledWith("tpl-1", '"v8"'),
    );
    expect(archiveTemplate).not.toHaveBeenCalled();
    expect(screen.queryByText(/Archive “/)).toBeNull();
    await waitFor(() => expect(onSettled).toHaveBeenCalled());
    expect(
      screen.getByText("Restored Spring launch to the library."),
    ).toBeTruthy();
  });
});
