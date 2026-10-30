// SPDX-License-Identifier: AGPL-3.0-only
//
// In-memory mock fixtures for the forms admin UI. Used when
// NEXT_PUBLIC_USE_MOCKS=1.

import {
  DEFAULT_SETTINGS,
  DEFAULT_STRUCTURE,
  type CreateFormInput,
  type Form,
  type FormListItem,
  type FormSubmission,
  type UpdateFormInput,
} from "./forms-types";

const TENANT = "tenant_mock";

const newsletter: Form = {
  id: "frm_newsletter",
  tenantId: TENANT,
  slug: "newsletter",
  name: "Newsletter signup",
  optInMode: "double",
  structure: DEFAULT_STRUCTURE,
  settings: {
    ...DEFAULT_SETTINGS,
    successMessage:
      "Almost there! Confirm your subscription via the email we just sent.",
    targetListId: "list_main",
    tagsOnSubmit: ["newsletter", "v1-signup"],
  },
  status: "published",
  createdAt: "2026-03-04T10:00:00Z",
  updatedAt: "2026-04-15T14:23:00Z",
};

const waitlist: Form = {
  id: "frm_waitlist",
  tenantId: TENANT,
  slug: "course-waitlist",
  name: "Course waitlist — Voice 101",
  optInMode: "single",
  structure: {
    fields: [
      {
        id: "h1",
        kind: "heading",
        label: "Voice 101",
        required: false,
        content: "Get on the Voice 101 waitlist",
      },
      {
        id: "p1",
        kind: "text",
        label: "Body",
        required: false,
        content:
          "Be the first to know when the next cohort opens. Limited to 50 seats.",
      },
      {
        id: "f_email",
        kind: "email",
        label: "Email",
        placeholder: "you@example.com",
        required: true,
      },
      {
        id: "f_role",
        kind: "custom",
        label: "What do you write?",
        placeholder: "Newsletter / blog / book",
        required: false,
        customKey: "role",
      },
      {
        id: "f_hp",
        kind: "honeypot",
        label: "Leave empty",
        required: false,
        defaultValue: "",
      },
      {
        id: "f_submit",
        kind: "submit",
        label: "Join waitlist",
        required: false,
      },
    ],
  },
  settings: {
    ...DEFAULT_SETTINGS,
    successMessage:
      "You're on the list. We'll email you when the next cohort opens.",
    successRedirectUrl: "https://acme.example.com/thanks",
    tagsOnSubmit: ["waitlist", "voice-101"],
  },
  status: "published",
  createdAt: "2026-03-21T08:30:00Z",
  updatedAt: "2026-04-22T19:11:00Z",
};

const feedback: Form = {
  id: "frm_feedback",
  tenantId: TENANT,
  slug: "feedback",
  name: "Reader feedback",
  optInMode: "single",
  structure: {
    fields: [
      {
        id: "h1",
        kind: "heading",
        label: "Heading",
        required: false,
        content: "What did you think?",
      },
      {
        id: "f_email",
        kind: "email",
        label: "Your email (optional)",
        required: false,
      },
      {
        id: "f_msg",
        kind: "custom",
        label: "What worked / didn't work?",
        required: true,
        customKey: "feedback",
      },
      {
        id: "f_hp",
        kind: "honeypot",
        label: "Leave empty",
        required: false,
        defaultValue: "",
      },
      {
        id: "f_submit",
        kind: "submit",
        label: "Send feedback",
        required: false,
      },
    ],
  },
  settings: {
    ...DEFAULT_SETTINGS,
    successMessage: "Thanks for the note. It actually gets read.",
  },
  status: "draft",
  createdAt: "2026-04-12T12:00:00Z",
  updatedAt: "2026-04-12T12:00:00Z",
};

/** Published multi-step fixture so the hosted survey experience can be
 * exercised end-to-end in demo mode, including every survey-only control. */
const readerSurvey: Form = {
  id: "frm_reader_survey",
  tenantId: TENANT,
  slug: "reader-survey",
  name: "Reader research survey",
  optInMode: "single",
  structure: {
    fields: [
      {
        id: "survey_heading",
        kind: "heading",
        label: "Reader research",
        content: "Help shape what we publish next",
        required: false,
      },
      {
        id: "survey_intro",
        kind: "text",
        label: "Introduction",
        content:
          "Three short steps. Your answers help us make every issue more useful.",
        required: false,
      },
      {
        id: "survey_email",
        kind: "email",
        label: "Email address",
        placeholder: "you@example.com",
        required: true,
      },
      {
        id: "survey_name",
        kind: "name",
        label: "Name",
        placeholder: "How should we address you?",
        required: false,
      },
      {
        id: "survey_role",
        kind: "select",
        label: "Which best describes you?",
        required: true,
        options: [
          { label: "Writer", value: "writer" },
          { label: "Marketer", value: "marketer" },
          { label: "Founder", value: "founder" },
          { label: "Curious reader", value: "reader" },
        ],
      },
      {
        id: "survey_break_1",
        kind: "step_break",
        label: "Reading habits",
        required: false,
      },
      {
        id: "survey_frequency",
        kind: "radio",
        label: "How often do you read our emails?",
        required: true,
        options: [
          { label: "Every issue", value: "every" },
          { label: "Most issues", value: "most" },
          { label: "Occasionally", value: "occasionally" },
        ],
      },
      {
        id: "survey_score",
        kind: "scale",
        label: "How useful are the issues today?",
        required: true,
        scaleMin: 1,
        scaleMax: 10,
      },
      {
        id: "survey_feedback",
        kind: "long_text",
        label: "What would make the newsletter more useful?",
        placeholder: "Topics, formats, or examples you would like to see…",
        required: true,
        customKey: "reader_feedback",
      },
      {
        id: "survey_break_2",
        kind: "step_break",
        label: "Anything else",
        required: false,
      },
      {
        id: "survey_attachment",
        kind: "file_upload",
        label: "Optional example or brief",
        required: false,
        acceptMime: ["application/pdf", "text/plain", "image/png"],
        maxBytes: 5 * 1024 * 1024,
      },
      {
        id: "survey_permission",
        kind: "checkbox",
        label: "You may contact me about my answers",
        required: false,
        customKey: "follow_up_ok",
      },
      {
        id: "survey_honeypot",
        kind: "honeypot",
        label: "Leave empty",
        required: false,
        defaultValue: "",
      },
      {
        id: "survey_submit",
        kind: "submit",
        label: "Send my answers",
        required: false,
      },
    ],
  },
  settings: {
    ...DEFAULT_SETTINGS,
    successMessage: "Thanks — your feedback will shape the next issue.",
    tagsOnSubmit: ["reader-research", "survey-2026"],
  },
  status: "published",
  createdAt: "2026-04-18T09:00:00Z",
  updatedAt: "2026-04-29T16:40:00Z",
};

const FORMS: Form[] = [newsletter, waitlist, readerSurvey, feedback];

const SUBMISSIONS: Record<string, FormSubmission[]> = {
  frm_newsletter: makeSubs("frm_newsletter", 47, "double"),
  frm_waitlist: makeSubs("frm_waitlist", 18, "single"),
  frm_reader_survey: makeSubs("frm_reader_survey", 31, "single"),
  frm_feedback: [],
};

function makeSubs(
  formId: string,
  count: number,
  mode: "single" | "double",
): FormSubmission[] {
  const out: FormSubmission[] = [];
  const start = Date.parse("2026-04-29T10:00:00Z");
  for (let i = 0; i < count; i++) {
    const submittedAt = new Date(start - i * 1000 * 60 * 60 * 5).toISOString();
    const confirmed = mode === "single" || i % 4 !== 0;
    out.push({
      id: `sub_${formId}_${i}`,
      formId,
      email: `reader${i}@example.com`,
      customFields: i % 3 === 0 ? { role: "newsletter writer" } : {},
      status: confirmed ? "confirmed" : "pending",
      ip: `203.0.113.${(i * 7) % 250}`,
      userAgent:
        i % 2 === 0
          ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Safari/605.1.15"
          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0",
      submittedAt,
      confirmedAt: confirmed
        ? new Date(start - i * 1000 * 60 * 60 * 5 + 1000 * 60 * 6).toISOString()
        : null,
    });
  }
  return out;
}

function withListMeta(f: Form): FormListItem {
  const subs = SUBMISSIONS[f.id] ?? [];
  const recent = subs.length;
  const visits30d = recent === 0 ? 0 : recent * 4;
  return {
    ...f,
    submissions30d: recent,
    conversionRate:
      visits30d === 0
        ? 0
        : Math.min(100, Math.round((recent / visits30d) * 100)),
    visits30d,
  };
}

export function mockListForms(): FormListItem[] {
  return FORMS.map(withListMeta);
}

export function mockGetForm(id: string): Form {
  const f = FORMS.find((x) => x.id === id);
  if (!f) throw new Error(`mock: no form ${id}`);
  return f;
}

export function mockCreateForm(input: CreateFormInput): Form {
  const id = `frm_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const f: Form = {
    id,
    tenantId: TENANT,
    slug: input.slug,
    name: input.name,
    optInMode: input.optInMode,
    structure: DEFAULT_STRUCTURE,
    settings: {
      ...DEFAULT_SETTINGS,
      successMessage: input.successMessage,
      successRedirectUrl: input.successRedirectUrl,
    },
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  FORMS.push(f);
  SUBMISSIONS[id] = [];
  return f;
}

export function mockUpdateForm(id: string, patch: UpdateFormInput): Form {
  const idx = FORMS.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`mock: no form ${id}`);
  const cur = FORMS[idx];
  const next: Form = {
    ...cur,
    ...patch,
    structure: patch.structure ?? cur.structure,
    settings: patch.settings ?? cur.settings,
    updatedAt: new Date().toISOString(),
  };
  FORMS[idx] = next;
  return next;
}

export function mockDeleteForm(id: string): void {
  const idx = FORMS.findIndex((x) => x.id === id);
  if (idx >= 0) FORMS.splice(idx, 1);
  delete SUBMISSIONS[id];
}

export function mockListSubmissions(formId: string): FormSubmission[] {
  return SUBMISSIONS[formId] ?? [];
}
