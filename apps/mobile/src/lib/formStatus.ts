/**
 * formStatus — presentation + search rules for signup forms.
 *
 * Pure (no react-native reachable) so the status/tone mapping and the search
 * fold are unit-tested rather than trusted.
 */
import type { PillTone } from "@/components/Pill";

export interface FormStatusPresentation {
  label: string;
  tone: PillTone;
  /** True when the form is actually capturing signups right now. */
  live: boolean;
}

/**
 * Map a stored status to a label + tone.
 *
 * "Live" and "Draft" are the two states an operator actually cares about, and
 * the distinction must never be carried by colour alone — the label says it.
 * An unrecognised value is reported as unrecognised rather than defaulted into
 * one of the real states.
 */
export function formStatusPresentation(
  raw: string | undefined,
): FormStatusPresentation {
  const status = (raw ?? "").trim().toLowerCase();
  if (status === "published") {
    return { label: "Live", tone: "success", live: true };
  }
  // The server treats an absent status as draft (FormsStatStrip does the same).
  if (status === "draft" || status === "") {
    return { label: "Draft", tone: "neutral", live: false };
  }
  if (status === "archived") {
    return { label: "Archived", tone: "neutral", live: false };
  }
  return { label: "Unrecognised status", tone: "warning", live: false };
}

export interface FormSearchable {
  name?: string;
  slug?: string;
}

function fold(value: string): string {
  const lower = value.toLowerCase();
  if (typeof lower.normalize !== "function") return lower;
  try {
    return lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
  } catch {
    return lower;
  }
}

/** Case- and diacritic-insensitive match over name + slug. Blank matches all. */
export function matchesFormQuery(
  form: FormSearchable,
  query: string,
): boolean {
  const needle = fold(query.trim());
  if (!needle) return true;
  return fold(`${form.name ?? ""} ${form.slug ?? ""}`).includes(needle);
}

/**
 * Validate the hosted-page URL the server hands back on the embed endpoint.
 *
 * The client deliberately does NOT construct this itself: FORMS_PUBLIC_HOST is
 * a deployment setting, and inferring it from the API origin is how you ship a
 * "View live page" button that opens a 404. We only accept an http(s) absolute
 * URL the server produced; anything else yields null and the affordance is not
 * offered at all.
 */
export function safeHostedFormUrl(
  publicUrl: string | null | undefined,
): string | null {
  const url = (publicUrl ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return null;
  return url;
}
