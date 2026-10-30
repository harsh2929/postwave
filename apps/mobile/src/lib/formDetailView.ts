/**
 * formDetailView — the derivations behind the form-detail screen.
 *
 * Everything here is a CLAIM the screen makes about the fetch, and each one is
 * a place a screen commonly lies:
 *
 *  - "not found" and "couldn't load" are different statements. 404/405/501
 *    means the deployment does not expose the surface; anything else is a
 *    fault the user can retry.
 *  - a 403 on analytics is a role boundary, not a breakage, and must say so.
 *  - the header subtitle must not assert a status before one has loaded.
 *
 * Pure module (no react-native reachable) so all of that is unit-tested.
 */
import { formStatusPresentation } from "@/lib/formStatus";

export interface ApiErrorLike {
  status: number;
  message: string;
}

export interface FormFetchState {
  /** The deployment does not expose this surface (or the row is gone). */
  unavailable: boolean;
  /** A real failure the user can retry. */
  hardError: boolean;
  /** Message for the hard-error branch. Never shown for `unavailable`. */
  errorMessage: string;
}

const NOT_DEPLOYED = new Set([404, 405, 501]);

export function formFetchState({
  error,
  threw,
  hasId,
}: {
  error: ApiErrorLike | null | undefined;
  threw: boolean;
  hasId: boolean;
}): FormFetchState {
  const unavailable = Boolean(error) && NOT_DEPLOYED.has(error?.status ?? 0);
  const hardError = !unavailable && (threw || Boolean(error) || !hasId);
  return {
    unavailable,
    hardError,
    errorMessage: !hasId
      ? "No form was selected. Go back and pick a form from the list."
      : (error?.message ??
        "Something went wrong. Check your connection and try again."),
  };
}

/** Analytics is reports-scoped; a 403 is a role boundary, not a breakage. */
export function analyticsErrorMessage(
  error: ApiErrorLike | null | undefined,
): string | null {
  if (!error) return null;
  if (error.status === 403) {
    return "Visit analytics unavailable — your role can't read reports.";
  }
  return `Visit analytics unavailable: ${error.message}`;
}

/** Submissions are admin-scoped; a non-admin never asks, so 403 is unexpected. */
export function submissionsErrorMessage(
  error: ApiErrorLike | null | undefined,
  threw: boolean,
): string | null {
  if (error) return error.message;
  return threw ? "Couldn't load submissions." : null;
}

/** Header title/subtitle. Asserts nothing before the row has loaded. */
export function formHeaderText(
  detail: { name?: string; slug?: string; status?: string; updatedAt?: string } | null,
  relative: (value: unknown) => string,
): { title: string; subtitle: string | undefined } {
  if (!detail) return { title: "Form", subtitle: undefined };
  const title = detail.name?.trim() || detail.slug?.trim() || "Form";
  const status = formStatusPresentation(detail.status).label;
  const subtitle = detail.updatedAt
    ? `${status} · updated ${relative(detail.updatedAt)}`
    : status;
  return { title, subtitle };
}
