// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const FormSpecSchema = z.object({
  name: z.string(),
  fields: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      type: z.enum(["email", "text", "checkbox", "select"]),
      required: z.boolean().optional(),
    }),
  ),
  double_optin: z.boolean().optional(),
  redirect_url: z.string().url().optional(),
  thank_you_message: z.string().optional(),
});

export function formTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "form_create",
      description:
        "Create a hosted form. Toggle `double_optin: true` to require email confirmation. Returns the form ID, hosted URL, and embed snippet.",
      schema: z.object({
        spec: FormSpecSchema,
      }),
      handler: async ({ spec }) => client.forms.create(spec as never),
    },
    {
      name: "form_submissions_list",
      description:
        "Paginated submissions for a form. Each submission includes timestamp, IP, user-agent, and the field values.",
      schema: z.object({
        form_id: z.string(),
      }),
      handler: async ({ form_id }) => client.forms.listSubmissions(form_id),
    },
    {
      name: "form_update",
      description:
        "Patch an existing hosted form. Pass only the fields to change in `patch` (name, fields, double_optin, redirect_url, thank_you_message). Returns the updated form.",
      schema: z.object({
        id: z.string().min(1),
        patch: z.record(z.string(), z.unknown()),
      }),
      handler: async ({ id, patch }) => client.forms.update(id, patch as never),
    },
    {
      name: "form_delete",
      description:
        "Delete a hosted form by id. Existing submissions are retained but the public submit/embed URLs stop accepting new entries. Idempotent.",
      schema: z.object({
        id: z.string().min(1),
      }),
      handler: async ({ id }) => client.forms.delete(id),
    },
    {
      name: "optin_confirm",
      description:
        "Programmatically confirm a pending double-opt-in submission via its confirmation token (the same token sent in the confirmation email). Returns ok plus the resolved subscriber email.",
      schema: z.object({
        token: z.string().min(1),
      }),
      handler: async ({ token }) => client.forms.confirmOptIn(token),
    },
    {
      name: "automation_trigger",
      description:
        "Fire a behavioral automation for a specific subscriber. Optional payload is passed to the first node's context.",
      schema: z.object({
        automation_id: z.string(),
        subscriber_email: z.string().email(),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      handler: async ({ automation_id, subscriber_email, payload }) =>
        client.automations.trigger({
          automation_id,
          subscriber_email,
          payload: payload ?? {},
        } as never),
    },
    {
      name: "automation_set_state",
      description:
        "Pause or resume an automation. `action` must be 'pause' or 'resume'. Idempotent.",
      schema: z.object({
        id: z.string(),
        action: z.enum(["pause", "resume"]),
      }),
      handler: async ({ id, action }) => {
        if (action === "pause") return client.automations.pause(id);
        return client.automations.resume(id);
      },
    },
  ];
}
