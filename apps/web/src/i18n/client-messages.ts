// SPDX-License-Identifier: AGPL-3.0-only
//
// The public subscriber surface (/[locale]/forms, /preferences, /landing,
// /archive, /gift) is the highest-volume anonymous surface in the product and
// the one where the visitor never has a warm cache. Handing the whole locale
// bundle to NextIntlClientProvider serializes it into every flight payload,
// so we hand over only the namespaces that CLIENT components actually read —
// server components use getTranslations() and never touch the provider.
//
// Keep this list in sync with the useTranslations() call sites under
// src/app/[locale]; src/__tests__/locale-client-messages.test.ts fails the
// build when a client component reads a namespace that is not listed here.
export const clientMessageNamespaces = [
  // LanguagePicker (public layouts)
  "language_picker",
  // landing/[slug]/subscribe-form.tsx
  "common",
  "landing",
  // SurveyForm on hosted multi-step form pages.
  "forms",
  // preferences/[token]/{preferences,frequency}-form.tsx — "preferences" also
  // covers the nested "preferences.frequency" namespace.
  "preferences",
] as const;

export type ClientMessageNamespace = (typeof clientMessageNamespaces)[number];

/**
 * Narrow a full locale bundle to the namespaces the browser needs. Missing
 * namespaces are skipped rather than emitted as `undefined` so the provider
 * never receives a key it cannot render.
 *
 * The return type stays the bundle's own type: next-intl's message type is an
 * index signature, so a subset of it is still a valid bundle — `Partial<…>`
 * would only add `undefined` to every value and fail the provider's prop type.
 */
export function pickClientMessages<Bundle extends Record<string, unknown>>(
  messages: Bundle,
): Bundle {
  const picked: Record<string, unknown> = {};
  for (const namespace of clientMessageNamespaces) {
    if (namespace in messages) picked[namespace] = messages[namespace];
  }
  return picked as Bundle;
}
