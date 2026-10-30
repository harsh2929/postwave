/**
 * Forms — starter template library.
 *
 * Activation > customization: every successful SaaS bridges the
 * empty-workspace gap with a small set of opinionated starters. The
 * four templates below cover the 80% of newsletter-creator use cases
 * we see in practice — signup, lead magnet, feedback, and webinar
 * registration. Operators who want a blank canvas can still hit
 * "New form" and skip the template row.
 *
 * Each template is self-contained: name, slug, opt-in mode, success
 * copy, and a pre-populated `fields[]` that mirrors the shape
 * consumed by `FormFieldsEditor` and persisted to `structure.fields`
 * on the server. No backend changes are required — the create flow
 * issues the normal `createForm` call and then PATCHes structure +
 * settings exactly as a manual edit would.
 *
 * Field shape mirrors `components/forms/FormFieldsEditor#FormField`:
 *
 *   { key, label, type, required?, options? }
 *
 * Types must be one of: text, email, tel, url, number, select,
 * checkbox, textarea. The public renderer at
 * apps/api/internal/forms/embed.go reads the same blob.
 *
 * IMPORTANT: don't import this from a server-only module — these
 * structures are tuned for the desktop client's create flow and
 * carry a few UI-only conveniences (the description string is for
 * the card grid, not the rendered form).
 */

import type { FormOptInMode } from "./api-client";

/** Field definition used in a template's `fields[]`. */
export interface FormsTemplateField {
  key: string;
  label: string;
  type:
    | "text"
    | "email"
    | "tel"
    | "url"
    | "number"
    | "select"
    | "checkbox"
    | "textarea";
  required?: boolean;
  options?: string[];
}

/**
 * Template definition consumed by the Forms page. The `icon` is a
 * tiny inline SVG path string so we don't add a new dep just for
 * four glyphs — rendered inside a 20×20 viewBox.
 */
export interface FormsTemplate {
  /** Stable key — used as React key and template-pick analytics id. */
  key: string;
  /** Human-readable template name, used as default form name. */
  name: string;
  /** Short pitch shown on the card. One line, sentence case. */
  description: string;
  /** Inline SVG path (24×24 viewBox, stroke=currentColor). */
  iconPath: string;
  /** Default opt-in mode — double for marketing, single for utility forms. */
  optInMode: FormOptInMode;
  /** Default success message shown after submit. */
  successMessage: string;
  /** Pre-populated custom fields beyond the always-on email input. */
  fields: FormsTemplateField[];
}

/**
 * The starter library. Ordering is deliberate: signup first (most
 * common), then lead magnet (next-most), then feedback, then webinar.
 * Keep this list at four — any more and the row stops feeling
 * curated.
 */
export const FORMS_TEMPLATES: FormsTemplate[] = [
  {
    key: "newsletter-signup",
    name: "Newsletter signup",
    description:
      "Email + optional first name with a GDPR consent box. The default for most senders.",
    // Mail / envelope glyph.
    iconPath:
      "M3 6.5l9 6 9-6M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
    optInMode: "double",
    successMessage: "Thanks! Check your inbox to confirm your subscription.",
    fields: [
      {
        key: "first_name",
        label: "First name",
        type: "text",
        required: false,
      },
      {
        key: "gdpr_consent",
        label:
          "I agree to receive emails and accept the privacy policy.",
        type: "checkbox",
        required: true,
      },
    ],
  },
  {
    key: "lead-magnet",
    name: "Lead magnet",
    description:
      "Get the free guide — email + first name, with a custom delivery thank-you.",
    // Download / arrow-down-to-tray glyph.
    iconPath:
      "M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
    optInMode: "single",
    successMessage:
      "Thanks! Your free guide is on its way — check your inbox in the next few minutes.",
    fields: [
      {
        key: "first_name",
        label: "First name",
        type: "text",
        required: true,
      },
    ],
  },
  {
    key: "feedback-survey",
    name: "Feedback survey",
    description:
      "NPS-style: a 0–10 rating plus a short open-ended comment. Quick to ship, easy to act on.",
    // Speech-bubble glyph.
    iconPath:
      "M21 12a8 8 0 0 1-11.5 7.2L4 21l1.8-5.5A8 8 0 1 1 21 12z",
    optInMode: "single",
    successMessage: "Thanks for the feedback — we read every response.",
    fields: [
      {
        key: "nps_rating",
        label: "How likely are you to recommend us? (0–10)",
        type: "select",
        required: true,
        options: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
      },
      {
        key: "comments",
        label: "What's the main reason for your score?",
        type: "textarea",
        required: false,
      },
    ],
  },
  {
    key: "webinar-registration",
    name: "Webinar registration",
    description:
      "Reserve a seat — name, email, and timezone so calendar invites land at the right hour.",
    // Calendar glyph.
    iconPath:
      "M8 2v4M16 2v4M3 10h18M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
    optInMode: "single",
    successMessage:
      "You're registered — calendar invite + join link are on their way.",
    fields: [
      {
        key: "full_name",
        label: "Full name",
        type: "text",
        required: true,
      },
      {
        key: "timezone",
        label: "Your timezone",
        type: "select",
        required: true,
        // Sensible default set — covers the vast majority of webinar
        // registrants; operators can extend in the slideover.
        options: [
          "Pacific (US/Canada)",
          "Mountain (US/Canada)",
          "Central (US/Canada)",
          "Eastern (US/Canada)",
          "UTC",
          "London (GMT/BST)",
          "Central Europe (CET/CEST)",
          "Eastern Europe (EET/EEST)",
          "India (IST)",
          "Singapore / China (SGT/CST)",
          "Japan (JST)",
          "Sydney (AET)",
        ],
      },
    ],
  },
];
