// SPDX-License-Identifier: AGPL-3.0-only

import { safeFormSuccessRedirectUrl } from "@/lib/forms-types";

export const SUBMISSION_ATTEMPT_FIELD = "submission_attempt_id";
export const SUBMISSION_ATTEMPT_RANDOM_BYTES = 16;
const MAX_PUBLIC_SUBMIT_RESPONSE_BYTES = 32 * 1024;
export const PUBLIC_FORM_SUBMIT_TIMEOUT_MS = 45_000;

/**
 * The accepted states the submit endpoint answers with. "received" is a
 * response that did not ask to subscribe: the form has a consent checkbox and
 * the visitor left it unticked.
 */
export type PublicFormAcceptedState =
  | "subscribed"
  | "pending-confirmation"
  | "received";

export type PublicFormSubmitOutcome =
  | {
      kind: "accepted";
      state: PublicFormAcceptedState;
      redirect?: string;
    }
  | { kind: "rejected"; message: string }
  | { kind: "uncertain" };

const ACCEPTED_STATES: ReadonlySet<unknown> = new Set<PublicFormAcceptedState>([
  "subscribed",
  "pending-confirmation",
  "received",
]);

/** Mint 128 bits of browser entropy as a URL-safe opaque identifier. */
export function mintSubmissionAttemptID(
  cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
  if (!cryptoSource?.getRandomValues) return "";
  const bytes = new Uint8Array(SUBMISSION_ATTEMPT_RANDOM_BYTES);
  try {
    cryptoSource.getRandomValues(bytes);
  } catch {
    return "";
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function setSubmissionAttemptField(
  form: HTMLFormElement,
  attemptID: string,
): HTMLInputElement {
  let input = form.querySelector<HTMLInputElement>(
    `input[type="hidden"][name="${SUBMISSION_ATTEMPT_FIELD}"]`,
  );
  if (!input) {
    input = document.createElement("input");
    input.type = "hidden";
    input.name = SUBMISSION_ATTEMPT_FIELD;
    form.append(input);
  }
  input.value = attemptID;
  return input;
}

export async function postPublicForm(
  actionURL: string,
  form: HTMLFormElement,
): Promise<PublicFormSubmitOutcome> {
  const body = new URLSearchParams();
  for (const [name, value] of new FormData(form).entries()) {
    // Survey file fields are uploaded separately and represented by their
    // hidden upload id. Never serialize a File into the urlencoded submit.
    if (typeof value === "string") body.append(name, value);
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () => controller.abort(),
    PUBLIC_FORM_SUBMIT_TIMEOUT_MS,
  );
  try {
    const response = await fetch(actionURL, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });
    if (response.status >= 500) return { kind: "uncertain" };

    const decoded = await readPublicSubmitJSON(response);
    if (response.ok) {
      if (!isRecord(decoded) || decoded.ok !== true)
        return { kind: "uncertain" };
      if (!ACCEPTED_STATES.has(decoded.state)) {
        return { kind: "uncertain" };
      }
      const safeRedirect =
        typeof decoded.redirect === "string"
          ? safeFormSuccessRedirectUrl(decoded.redirect)
          : "";
      return {
        kind: "accepted",
        state: decoded.state as PublicFormAcceptedState,
        ...(safeRedirect ? { redirect: safeRedirect } : {}),
      };
    }

    // A bounded 4xx is a deterministic rejection. Rotate the attempt before a
    // visitor edits/retries; never echo arbitrary proxy HTML or unknown fields.
    const message =
      isRecord(decoded) &&
      isRecord(decoded.error) &&
      typeof decoded.error.message === "string" &&
      decoded.error.message.length > 0 &&
      decoded.error.message.length <= 500
        ? decoded.error.message
        : "We could not accept that submission. Review the form and try again.";
    return { kind: "rejected", message };
  } catch {
    // The server may have received and dispatched the request. The caller must
    // retain its attempt id for an exact retry.
    return { kind: "uncertain" };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function resetPublicFormCaptcha(form: HTMLFormElement): void {
  const token = form.querySelector<HTMLTextAreaElement | HTMLInputElement>(
    '[name="g-recaptcha-response"]',
  );
  if (token) token.value = "";
  const recaptcha = (
    globalThis as typeof globalThis & {
      grecaptcha?: { reset: () => void };
    }
  ).grecaptcha;
  try {
    recaptcha?.reset();
  } catch {
    // Native/no-JS fallback remains available; captcha re-renders on reload.
  }
}

/**
 * The page a visitor lands on after an accepted submission. The mode picks
 * its copy and must match the API's native-post redirect: "double" asks them
 * to check their inbox, "received" thanks them without claiming a
 * subscription, "single" says they are subscribed.
 */
export function publicFormSuccessURL(
  slug: string,
  state: PublicFormAcceptedState,
  redirect?: string,
): string {
  const safe = redirect ? safeFormSuccessRedirectUrl(redirect) : null;
  if (safe) return safe;
  const mode =
    state === "pending-confirmation"
      ? "double"
      : state === "received"
        ? "received"
        : "single";
  return `/forms/success?form=${encodeURIComponent(slug)}&mode=${mode}`;
}

async function readPublicSubmitJSON(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (
    Number.isFinite(declared) &&
    declared > MAX_PUBLIC_SUBMIT_RESPONSE_BYTES
  ) {
    return null;
  }
  let text = "";
  if (!response.body) {
    text = await response.text();
    if (
      new TextEncoder().encode(text).byteLength >
      MAX_PUBLIC_SUBMIT_RESPONSE_BYTES
    ) {
      return null;
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PUBLIC_SUBMIT_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
