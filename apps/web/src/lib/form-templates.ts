// SPDX-License-Identifier: AGPL-3.0-only
//
// Starter-template gallery for the New-form flow (FORM-028). Each template
// seeds a complete `FormStructure` so first-run users don't face a blank
// builder. The structures reuse the same field kinds the builder/compiler
// support (forms-types.ts FieldKind). Ids are template-local and stable so the
// output is deterministic and unit-testable.

import type { FormStructure, OptInMode } from "./forms-types";
import { DEFAULT_STRUCTURE } from "./forms-types";

export interface FormTemplate {
  id: string;
  name: string;
  description: string;
  /** Recommended opt-in mode for this shape. */
  optInMode: OptInMode;
  structure: FormStructure;
}

function heading(content: string) {
  return { id: "h", kind: "heading" as const, label: "Heading", required: false, content };
}
const emailField = {
  id: "email",
  kind: "email" as const,
  label: "Email address",
  placeholder: "you@example.com",
  required: true,
};
const consentField = {
  id: "consent",
  kind: "checkbox" as const,
  label: "I agree to receive emails. You can unsubscribe at any time.",
  required: true,
};
const honeypot = {
  id: "hp",
  kind: "honeypot" as const,
  label: "Leave this empty",
  required: false,
  defaultValue: "",
};
function submit(label: string) {
  return { id: "submit", kind: "submit" as const, label, required: false };
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    id: "blank",
    name: "Blank form",
    description: "Start from the default newsletter skeleton and customize.",
    optInMode: "double",
    structure: DEFAULT_STRUCTURE,
  },
  {
    id: "newsletter",
    name: "Newsletter signup",
    description: "Email + consent, double opt-in. The classic list-builder.",
    optInMode: "double",
    structure: {
      fields: [
        heading("Subscribe to our newsletter"),
        emailField,
        { id: "name", kind: "name", label: "First name", placeholder: "Jane", required: false },
        consentField,
        honeypot,
        submit("Subscribe"),
      ],
    },
  },
  {
    id: "waitlist",
    name: "Waitlist",
    description: "Collect early-access signups before launch.",
    optInMode: "single",
    structure: {
      fields: [
        heading("Join the waitlist"),
        emailField,
        { id: "name", kind: "name", label: "Name", placeholder: "Jane", required: false },
        {
          id: "referrer",
          kind: "custom",
          label: "How did you hear about us?",
          customKey: "referral_source",
          required: false,
        },
        honeypot,
        submit("Request access"),
      ],
    },
  },
  {
    id: "contact",
    name: "Contact form",
    description: "Name, email, and a message field for inbound enquiries.",
    optInMode: "single",
    structure: {
      fields: [
        heading("Get in touch"),
        { id: "name", kind: "name", label: "Name", placeholder: "Jane", required: true },
        emailField,
        {
          id: "message",
          kind: "long_text",
          label: "Message",
          placeholder: "How can we help?",
          customKey: "message",
          required: true,
        },
        honeypot,
        submit("Send message"),
      ],
    },
  },
  {
    id: "nps",
    name: "NPS / Survey",
    description: "A 0–10 rating scale plus an open follow-up question.",
    optInMode: "single",
    structure: {
      fields: [
        heading("How likely are you to recommend us?"),
        emailField,
        {
          id: "score",
          kind: "scale",
          label: "Score (0 = not likely, 10 = very likely)",
          customKey: "nps_score",
          required: true,
          scaleMin: 0,
          scaleMax: 10,
        },
        {
          id: "why",
          kind: "long_text",
          label: "What's the main reason for your score?",
          customKey: "nps_reason",
          required: false,
        },
        honeypot,
        submit("Submit feedback"),
      ],
    },
  },
  {
    id: "lead-gen",
    name: "Lead-gen",
    description: "Qualify leads with company, role, and an asset upload.",
    optInMode: "single",
    structure: {
      fields: [
        heading("Download the guide"),
        { id: "name", kind: "name", label: "Full name", placeholder: "Jane Doe", required: true },
        emailField,
        {
          id: "company",
          kind: "custom",
          label: "Company",
          customKey: "company",
          required: true,
        },
        {
          id: "role",
          kind: "select",
          label: "Your role",
          customKey: "role",
          required: false,
          options: [
            { label: "Founder / C-level" },
            { label: "Marketing" },
            { label: "Engineering" },
            { label: "Other" },
          ],
        },
        consentField,
        honeypot,
        submit("Get the guide"),
      ],
    },
  },
];

export function getFormTemplate(id: string): FormTemplate | undefined {
  return FORM_TEMPLATES.find((t) => t.id === id);
}
