/**
 * hooks/useFormOps.ts — the forms lifecycle writes (desktop-parity pass).
 *
 * TRANSPORT POLICY, one line per verb, each decided by lib/offlineQueueSafety
 * rather than re-argued here:
 *
 *  - STATUS is ONLINE-ONLY. `isSafeQueueBody` refuses a forms PATCH carrying
 *    `status` — publish/unpublish changes a PUBLIC surface, and the point of
 *    pulling a misbehaving form is that it stops NOW, not after a tunnel.
 *  - DELETE is ONLINE-ONLY. Every DELETE is (blanket denylist), and this one
 *    is a HARD delete cascading through submissions.
 *  - CREATE rides the OFFLINE OUTBOX. `POST /api/v1/forms` is on the
 *    allowlist, and the server hardcodes new forms to `draft`
 *    (repo.go:207-208), so a create replayed from a tunnel changes nothing
 *    public — going live stays a separate, online-only publish.
 *  - The CSV export and the VARIANT admin verbs are online-only: an export is
 *    a read the user is standing there waiting for, and a variant
 *    pause/evaluate changes what visitors see.
 *
 * Role floors (routeauth manifest): PATCH = editor; DELETE, submissions.csv
 * and every variant verb = admin. Screens gate with `canAccessMinimumRole`
 * BEFORE rendering the affordance.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  CREATE_FORM_PATH,
  createFormBody,
  createFormVariant,
  deleteForm,
  deleteFormVariant,
  evaluateFormVariants,
  fetchFormSubmissionsCsv,
  updateFormStatus,
  updateFormVariant,
  type CreateFormInput,
  type FormDetail,
} from "@/api/forms";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { isProbablyOnline } from "@/lib/connectivity";
import {
  formSubmissionsCsvShare,
  type FormSubmissionsExport,
} from "@/lib/formSubmissionsExport";
import { executeEntityWrite, type EntityWriteVars } from "@/lib/offlineEntityWrite";
import { OFFLINE_MUTATION_KEYS } from "@/lib/offlineMutationContract";
import { newOfflineMutationMetadata } from "@/lib/offlineMutations";
import { offlineSafeMutationMeta } from "@/lib/queryClient";

/** Mirrors DiscountOfflineError: an honest refusal at the moment of the tap. */
export class FormsOfflineError extends Error {
  readonly code = "offline_write_refused";

  constructor(action: string) {
    super(`${action} needs a connection. Reconnect and try again.`);
    this.name = "FormsOfflineError";
  }
}

/**
 * The two query keys a form-row change dirties: the list and this detail.
 * Exported for the node test — the invalidation set IS the contract here.
 */
export function formWriteInvalidations(
  tenantId: string | null,
  id: string,
): readonly (readonly unknown[])[] {
  return [
    ["forms", tenantId],
    ["form", tenantId, id],
  ];
}

/**
 * Per-form keys that must be REMOVED (not refetched) after a delete:
 * re-reading any of them against a hard-deleted id is a guaranteed 404.
 */
export function deletedFormQueryKeys(
  tenantId: string | null,
  id: string,
): readonly (readonly unknown[])[] {
  return [
    ["form", tenantId, id],
    ["form-analytics", tenantId, id],
    ["form-submissions", tenantId, id],
    ["form-embed", tenantId, id],
    ["form-variants", tenantId, id],
    ["form-variant-promotions", tenantId, id],
  ];
}

/** The exact queue record a form create enqueues. Pure, for the node test. */
export function buildCreateFormVars(
  meta: Pick<EntityWriteVars, "auth" | "operationId">,
  input: CreateFormInput,
): EntityWriteVars {
  return {
    ...meta,
    method: "POST",
    path: CREATE_FORM_PATH,
    body: createFormBody(input),
    queuedAt: new Date().toISOString(),
    invalidateRoots: ["forms"],
    label: "Create form",
  };
}

/** PATCH {status} — online-only (see the header). */
export function useUpdateFormStatus() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      status: "draft" | "published" | "archived";
    }): Promise<FormDetail | null> => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Changing what the public is served");
      return updateFormStatus(input.id, input.status);
    },
    onSuccess: (_data, input) => {
      for (const key of formWriteInvalidations(tenantId, input.id)) {
        void queryClient.invalidateQueries({ queryKey: key as unknown[] });
      }
    },
  });
}

/** HARD delete — admin, typed-phrase-confirmed by the caller, online-only. */
export function useDeleteForm() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!isProbablyOnline()) throw new FormsOfflineError("Deleting a form");
      return deleteForm(id);
    },
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ["forms", tenantId] });
      for (const key of deletedFormQueryKeys(tenantId, id)) {
        queryClient.removeQueries({ queryKey: key as unknown[] });
      }
    },
  });
}

/**
 * Create rides the generic offline outbox: paused offline, persisted to the
 * encrypted vault, replayed serially on reconnect with the operationId as the
 * Idempotency-Key, re-validated against the route allowlist at replay time.
 */
export function useCreateForm() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  const inner = useMutation({
    mutationKey: OFFLINE_MUTATION_KEYS.entityWrite,
    meta: offlineSafeMutationMeta,
    mutationFn: executeEntityWrite,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["forms", tenantId] });
    },
  });

  const mutate = (
    input: CreateFormInput,
    options?: Parameters<typeof inner.mutate>[1],
  ) => {
    inner.mutate(buildCreateFormVars(newOfflineMutationMetadata(), input), options);
  };

  return { ...inner, mutate };
}

/** Fetch + bound + neutralise the submissions CSV for the share sheet. */
export function useExportFormSubmissions() {
  return useMutation({
    mutationFn: async (input: {
      id: string;
      formName: string;
    }): Promise<FormSubmissionsExport> => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Exporting submissions");
      const raw = await fetchFormSubmissionsCsv(input.id);
      return formSubmissionsCsvShare(raw, { formName: input.formName });
    },
  });
}

/** Shared invalidation for every variant write: rows AND promotions. */
function useVariantInvalidation() {
  const queryClient = useQueryClient();
  const { tenantId } = useOnlineQueryGate();
  return (formId: string) => {
    void queryClient.invalidateQueries({
      queryKey: ["form-variants", tenantId, formId],
    });
    // Evaluate can mint a promotion server-side, and pause/delete change
    // which arms the verdict is computed over — refresh both reads.
    void queryClient.invalidateQueries({
      queryKey: ["form-variant-promotions", tenantId, formId],
    });
  };
}

export function useCreateFormVariant() {
  const invalidate = useVariantInvalidation();
  return useMutation({
    mutationFn: async (input: {
      formId: string;
      label: string;
      trafficPct?: number;
    }) => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Creating a variant");
      const body: { label: string; trafficPct?: number } = {
        label: input.label,
      };
      if (input.trafficPct !== undefined) body.trafficPct = input.trafficPct;
      return createFormVariant(input.formId, body);
    },
    onSuccess: (_d, input) => invalidate(input.formId),
  });
}

export function useUpdateFormVariant() {
  const invalidate = useVariantInvalidation();
  return useMutation({
    mutationFn: async (input: {
      formId: string;
      variantId: string;
      patch: {
        label?: string;
        trafficPct?: number;
        status?: "exploring" | "paused";
      };
    }) => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Changing a variant");
      return updateFormVariant(input.formId, input.variantId, input.patch);
    },
    onSuccess: (_d, input) => invalidate(input.formId),
  });
}

export function useDeleteFormVariant() {
  const invalidate = useVariantInvalidation();
  return useMutation({
    mutationFn: async (input: { formId: string; variantId: string }) => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Removing a variant");
      return deleteFormVariant(input.formId, input.variantId);
    },
    onSuccess: (_d, input) => invalidate(input.formId),
  });
}

export function useEvaluateFormVariants() {
  const invalidate = useVariantInvalidation();
  return useMutation({
    mutationFn: async (formId: string) => {
      if (!isProbablyOnline())
        throw new FormsOfflineError("Evaluating variants");
      return evaluateFormVariants(formId);
    },
    onSuccess: (_d, formId) => invalidate(formId),
  });
}
