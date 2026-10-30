// SPDX-License-Identifier: MIT
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface PromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

interface PromptDef {
  name: string;
  description: string;
  arguments?: PromptArg[];
  /** Build the system+user message stack. */
  build: (args: Record<string, string>) => Array<{
    role: "user" | "assistant";
    content: { type: "text"; text: string };
  }>;
}

export function buildMailchimpMigrationPrompt(): ReturnType<
  PromptDef["build"]
> {
  return [
    {
      role: "user",
      content: {
        type: "text",
        text:
          "Migrate my newsletter from Mailchimp into Moosewave. Use the migrate_* tools end-to-end:\n" +
          "1. Call migrate_start with source='mailchimp' and present me the authorize_url to open. If reconnecting an existing migration, pass its callback job ID as job_id and verify the callback preserves that same job ID.\n" +
          "2. Once I provide the callback job ID, use it as session_id for migrate_discover, show me the returned audiences, and ask me to choose the explicit audience scope. You may repeat discovery with selected_audience_ids for planning, but explain that this scoped inventory is informative rather than the persisted approval boundary.\n" +
          "3. Call migrate_dry_run with the chosen scope. Poll migrate_status every 30s until status is awaiting_confirmation or failed. Treat selected_audience_ids on that job as the authoritative normalized scope; show me the verification_report, Customer Journey manual-rebuild gap, and anything in 'segments_with_warnings' or 'automations_unsupported'.\n" +
          "4. Wait for my explicit confirmation, then call migrate_commit with exactly the authoritative selected_audience_ids from the reviewed dry-run. Poll migrate_status every 30s until completed or failed.\n" +
          "5. Confirm the conflict-aware rollback window (7 days) is recorded and that rollback never changes Mailchimp. If I request rollback, call migrate_rollback and poll migrate_rollback_status until completed or failed.",
      },
    },
  ];
}

export function buildAssureCampaignPrompt(
  args: Record<string, string>,
): ReturnType<PromptDef["build"]> {
  return [
    {
      role: "user",
      content: {
        type: "text",
        text:
          `Assure campaign ${args.campaign_id} before sending:\n` +
          `1. Call campaign_assurance_run for content revision ${args.content_revision_id} and send plan ${args.send_plan_id}, using newly generated stable request_id and idempotency_key values. Explain that the run is potentially billable and wait for my approval before calling it.\n` +
          "2. Poll campaign_assurance_get with view='events' until the run is terminal. This route is a current aggregate snapshot, not an event history or SSE stream.\n" +
          "3. Read view='evidence'. Separate deterministic findings, modeled Predicted Agent Comprehension, controlled observations, and unavailable evidence. Never call a model result a Gemini or recipient-inbox observation.\n" +
          "4. If a deterministic blocker has a stored typed remediation, explain the exact finding and consequences, obtain the current exact strong campaign ETag, and wait for my explicit approval before campaign_assurance_apply_fix. Supply only campaign/run/finding IDs, stable request_id and idempotency_key values, and if_match; never invent or submit patch instructions.\n" +
          "5. After an application, show the new immutable revision and append-only receipt, treat the originating run as stale, obtain a send plan for the new revision, and run assurance again. Never claim the content is fixed from the application receipt alone.\n" +
          "6. Never override automatically. For an overridable finding, ask for an owner/admin decision and exact rationale before campaign_assurance_override.\n" +
          "7. Ask for explicit approval before campaign_send; the server-side exact-hash gate remains authoritative.",
      },
    },
  ];
}

const PROMPTS: PromptDef[] = [
  {
    name: "migrate-from-mailchimp",
    description:
      "Walk through a full Mailchimp migration: OAuth, discovery, dry-run review, commit, and verification.",
    build: buildMailchimpMigrationPrompt,
  },
  {
    name: "diagnose-last-campaign",
    description:
      "Pull the most recent campaign and run the AI Diagnostician; present ranked fixes.",
    build: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Diagnose my most recent campaign:\n" +
            "1. Read moosewave://recent-campaigns and pick the most recently sent.\n" +
            "2. Call diagnose_campaign with that campaign_id.\n" +
            "3. Present the top 5 ranked fixes with severity and a one-line action for each.\n" +
            "4. If any fix is `auth_dns`, also call check_auth and quote the failing record.",
        },
      },
    ],
  },
  {
    name: "write-welcome-sequence",
    description:
      "Ensure a voice profile exists, then generate a 7-email welcome sequence written in the user's voice.",
    build: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Write me a 7-email welcome sequence using my voice:\n" +
            "1. Call voice_profile_get. If `sources` is empty, ask me to add one (RSS feed of my blog is the easiest) and call voice_source_add + voice_profile_build.\n" +
            "2. Read moosewave://templates and pick a 7-email welcome template (slug typically 'welcome-7' or similar).\n" +
            "3. Call sequence_generate with that template_id.\n" +
            "4. Show me each email's subject, fidelity score, and first paragraph. Offer to regenerate any email under 0.7 fidelity using sequence_regenerate_email.",
        },
      },
    ],
  },
  {
    name: "improve-deliverability",
    description:
      "Audit SPF / DKIM / DMARC + reputation; surface the top 3 fixes.",
    build: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Audit my deliverability and surface the top 3 fixes:\n" +
            "1. Call check_auth — list any SPF/DKIM/DMARC/BIMI records that fail.\n" +
            "2. Call check_reputation — note SenderScore and any blocklist hits.\n" +
            "3. Read moosewave://recent-campaigns; for the most recent campaign, call diagnose_campaign.\n" +
            "4. Combine: present exactly 3 fixes ranked by impact, each with the evidence and the action.",
        },
      },
    ],
  },
  {
    name: "audit-list-hygiene",
    description:
      "Review suppression list, bounce rate, and complaint rate; suggest pruning.",
    build: () => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            "Audit my list hygiene:\n" +
            "1. Call subscribers_list with per_page=1 to get the total subscriber count.\n" +
            "2. Read moosewave://recent-campaigns; compute average bounce + complaint rate across the last 5.\n" +
            "3. If bounces > 2% or complaints > 0.1%, recommend a re-engagement segment evaluated via segment_eval.\n" +
            "4. Suggest concrete pruning actions and the count that would be affected.",
        },
      },
    ],
  },
  {
    name: "weekly-digest-from-rss",
    description:
      "Pull the latest items from an RSS feed and draft a weekly digest in the user's voice.",
    arguments: [
      { name: "rss_url", description: "Public RSS feed URL.", required: true },
    ],
    build: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Draft this week's digest using items from ${args.rss_url}:\n` +
            "1. Read moosewave://voice-profile to recall the tone.\n" +
            "2. Pull the last 5 items from the feed and summarize each in 1-2 lines.\n" +
            "3. Call sequence_generate with a 'digest-weekly' template, passing the items as variables.\n" +
            "4. Show me the draft and offer to schedule via campaign_create + campaign_send.",
        },
      },
    ],
  },
  {
    name: "re-engage-cold-subscribers",
    description:
      "Identify subscribers who have not opened in N days and generate a winback sequence for them.",
    arguments: [
      {
        name: "days",
        description: "Cold-window cutoff (default 90).",
        required: false,
      },
    ],
    build: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Find cold subscribers (no opens in ${args.days ?? "90"} days) and generate a winback sequence:\n` +
            "1. Call segment_eval with an AST that matches `last_opened` older than the cutoff.\n" +
            "2. Show me the count and a sample.\n" +
            "3. Call sequence_generate with a 're-engagement' template.\n" +
            "4. Offer to launch the sequence with automation_trigger for each cold subscriber, OR as a one-off campaign.",
        },
      },
    ],
  },
  {
    name: "email-from-jsx",
    description:
      "Render a React component from a path the user names into email-safe HTML via @postwave/email-react, then preview or save as a campaign.",
    arguments: [
      {
        name: "path",
        description: "Path to the .tsx file (relative to repo root).",
        required: true,
      },
      {
        name: "audience",
        description: "Audience: list_id or segment_id (optional).",
        required: false,
      },
    ],
    build: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Render the email at ${args.path} and prepare it for sending:\n` +
            "1. Read the file and confirm it default-exports a React element using @postwave/email-react primitives. If not, refactor it to use Email/Section/Column/Text/Heading/Button/Image/Divider/Spacer/Link/SocialRow/Footer.\n" +
            "2. Compile it: import `renderToHtml` from `@postwave/email-react` and call it on the default export. Capture { html, mjml, errors }. If errors is non-empty, fix the source and recompile.\n" +
            "3. Preview the result by calling render_preview_html with the html. Show me one screenshot URL per environment.\n" +
            "4. Ask whether to (a) save as a draft campaign via campaign_create with the mjml and an audience" +
            (args.audience ? ` (use ${args.audience})` : "") +
            ", or (b) just send a test message to me via send_test_email.\n" +
            "5. Wait for explicit confirmation before any send.",
        },
      },
    ],
  },
  {
    name: "email-from-markdown",
    description:
      "Wrap a markdown body in a basic Email template, render to HTML, preview, and draft a campaign.",
    arguments: [
      { name: "subject", description: "Subject line.", required: true },
      {
        name: "markdown",
        description: "Markdown body content.",
        required: true,
      },
    ],
    build: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Turn the following markdown into a sendable email with subject "${args.subject}":\n\n` +
            `---\n${args.markdown}\n---\n\n` +
            "1. Convert the markdown to a React tree using @postwave/email-react primitives. Wrap everything in a single <Email preview=…><Section><Column>…</Column></Section><Footer …/></Email>. Use Heading for # / ## headings, Text for paragraphs, Button for any 'call to action' lines, and Link for inline links.\n" +
            "2. Call renderToHtml on the tree. If errors is non-empty, fix and recompile.\n" +
            "3. Call render_preview_html with the html and show me one preview per environment.\n" +
            "4. Call predict_placement with the html and the subject; show predicted Primary / Promotions / Spam.\n" +
            "5. Offer to draft a campaign via campaign_create (subject + mjml) once I confirm the preview looks right.",
        },
      },
    ],
  },
  {
    name: "assure-campaign-before-send",
    description:
      "Freeze and inspect Campaign Assurance before asking to queue a campaign.",
    arguments: [
      {
        name: "campaign_id",
        description: "Draft campaign ID.",
        required: true,
      },
      {
        name: "content_revision_id",
        description: "Exact frozen content revision ID.",
        required: true,
      },
      {
        name: "send_plan_id",
        description: "Exact frozen send-plan ID.",
        required: true,
      },
    ],
    build: buildAssureCampaignPrompt,
  },
  {
    name: "setup-double-optin-form",
    description:
      "Create a hosted form with double opt-in flow and explain how to embed it.",
    arguments: [
      {
        name: "list_name",
        description: "Friendly name for the new list/form.",
        required: true,
      },
    ],
    build: (args) => [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Create a double opt-in signup form named "${args.list_name}":\n` +
            "1. Call form_create with a spec that has fields=[{key:'email',type:'email',label:'Email',required:true}], double_optin=true, and a polite thank-you message.\n" +
            "2. Show me the hosted URL and the embed snippet.\n" +
            "3. Explain to me, in 3 lines, how the confirmation email works and where to customize it.",
        },
      },
    ],
  },
];

export function registerPrompts(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments ?? [],
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const def = PROMPTS.find((p) => p.name === req.params.name);
    if (!def) throw new Error(`unknown prompt: ${req.params.name}`);
    const args = (req.params.arguments ?? {}) as Record<string, string>;
    return {
      description: def.description,
      messages: def.build(args),
    };
  });
}
