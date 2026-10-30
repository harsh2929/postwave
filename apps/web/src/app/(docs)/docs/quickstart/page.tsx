// Moosewave docs - 5-step quickstart with API equivalents.

import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";

import { Breadcrumbs } from "@/components/docs/Breadcrumbs";
import { Callout } from "@/components/docs/Callout";
import { CodeBlock } from "@/components/docs/CodeBlock";

export const metadata: Metadata = {
  title: "Quickstart · Moosewave docs",
  description:
    "Five steps from sign-up to first campaign. Connect a domain, import subscribers, build a voice profile, send a campaign, monitor deliverability.",
  alternates: { canonical: "/docs/quickstart" },
};

interface Step {
  n: number;
  title: string;
  body: React.ReactNode;
  code: { caption: string; language: string; src: string };
}

const STEPS: Step[] = [
  {
    n: 1,
    title: "Sign up and connect a sending domain",
    body: (
      <>
        Create an account at{" "}
        <Link href="/signup" className="underline">
          moosewave.com/signup
        </Link>
        , then register a sending identity with the call below. Moosewave
        provisions DKIM, SPF, and DMARC records for you to publish, then
        verifies them when you call the verify endpoint. (Sending identities are
        API-managed; <strong>Settings → Domain &amp; DNS</strong> is a separate,
        read-only legacy ownership registry. Customer-host registration,
        re-check, TLS, and routing remain release-held.)
      </>
    ),
    code: {
      caption: "POST /api/v1/sending-identities",
      language: "bash",
      src: `curl -X POST "https://api.moosewave.com/api/v1/sending-identities" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "domain": "send.example.com" }'`,
    },
  },
  {
    n: 2,
    title: "Import subscribers",
    body: (
      <>
        Run{" "}
        <Link href="/docs/migrations" className="underline">
          a migration
        </Link>{" "}
        from your existing ESP. The wizard uses the source&apos;s auth style
        (OAuth, API token plus account URL, API key, or CSV upload), takes a
        pre-flight inventory, then runs a dry-run before any commit.
        Subscribers, suppression lists, and custom fields are checked in the
        verification report; ActiveCampaign automations are preserved as
        rebuild-review evidence instead of being activated automatically.
      </>
    ),
    code: {
      caption: "POST /api/v1/migrations/activecampaign/credentials",
      language: "bash",
      src: `JOB_ID=$(curl -sS -X POST "https://api.moosewave.com/api/v1/migrations/activecampaign/credentials" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"api_key\\": \\"$ACTIVECAMPAIGN_API_TOKEN\\", \\"extra\\": { \\"api_url\\": \\"https://account.api-us1.com/api/3\\" } }" \\
  | jq -r .job_id)

curl -X POST "https://api.moosewave.com/api/v1/migrations/activecampaign/discover" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"job_id\\": \\"$JOB_ID\\" }"

curl -X POST "https://api.moosewave.com/api/v1/migrations/activecampaign/dry-run" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"job_id\\": \\"$JOB_ID\\" }"

# Review the dry-run report before committing any writes.
curl -X POST "https://api.moosewave.com/api/v1/migrations/activecampaign/commit" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{ \\"job_id\\": \\"$JOB_ID\\" }"`,
    },
  },
  {
    n: 3,
    title: "Build a voice profile",
    body: (
      <>
        Add at least three writing samples (RSS, web archive, paste-in, or
        Twitter handle) and trigger <strong>voice_profile_build</strong>. The
        profile drives sequence generation in your voice.
      </>
    ),
    code: {
      caption: "POST /api/v1/voice/profile/build",
      language: "bash",
      src: `curl -X POST "https://api.moosewave.com/api/v1/voice/sources" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "type": "blog_rss", "params": { "url": "https://example.com/feed.xml" } }'

curl -X POST "https://api.moosewave.com/api/v1/voice/profile/build" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
    },
  },
  {
    n: 4,
    title: "Send your first campaign",
    body: (
      <>
        Generate a sequence from one of the 50 templates, pick a step, edit the
        body, and queue the send. Moosewave validates against the spam scorer and
        the AI Diagnostician before the campaign leaves the queue.
      </>
    ),
    code: {
      caption: "POST /api/v1/voice/sequences",
      language: "bash",
      src: `# Template ids are assigned when the catalog is seeded, so look yours
# up by its stable slug rather than hardcoding an id.
TEMPLATE_ID=$(curl -sS "https://api.moosewave.com/api/v1/voice/templates" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  | jq -r '.items[] | select(.slug == "welcome-3-email") | .id')

# Pass every variable the template declares as required.
curl -X POST "https://api.moosewave.com/api/v1/voice/sequences" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"template_id\\": \\"$TEMPLATE_ID\\",
    \\"variables\\": {
      \\"newsletter_name\\": \\"The Margin\\",
      \\"audience\\": \\"indie SaaS founders\\",
      \\"best_of_url\\": \\"https://example.com/the-pricing-flinch\\",
      \\"best_of_title\\": \\"The Pricing Flinch\\",
      \\"writer_first_name\\": \\"Maya\\"
    }
  }"`,
    },
  },
  {
    n: 5,
    title: "Monitor deliverability",
    body: (
      <>
        Open <strong>Inbox Reality</strong> after the campaign sends. Moosewave
        scores reputation, validates SPF/DKIM/DMARC/BIMI, and pulls the seedlist
        report. The Diagnostician explains placement and proposes ranked fixes.
      </>
    ),
    code: {
      caption: "GET /api/v1/inbox-reality/campaigns/{id}",
      language: "bash",
      src: `curl "https://api.moosewave.com/api/v1/inbox-reality/campaigns/cmp_42" \\
  -H "Authorization: Bearer $POSTWAVE_API_KEY"`,
    },
  },
];

export default function QuickstartPage(): JSX.Element {
  return (
    <article className="space-y-10">
      <Breadcrumbs
        items={[
          { label: "Docs", href: "/docs/getting-started" },
          { label: "Quickstart" },
        ]}
      />
      <header className="space-y-3">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">
          Quickstart
        </h1>
        <p className="text-pw-muted-on-paper max-w-3xl leading-relaxed">
          From sign-up to a delivered campaign in five steps. Each step shows
          the equivalent API call so you can script the full flow.
        </p>
      </header>

      <Callout variant="info" title="Prerequisites">
        A Moosewave account and an API key (Settings → API keys).
      </Callout>

      <ol className="space-y-10">
        {STEPS.map((s) => (
          <li key={s.n} className="space-y-3">
            <h2 className="text-xl md:text-2xl font-semibold tracking-tight">
              <span className="text-pw-muted-on-paper font-mono mr-2">
                {String(s.n).padStart(2, "0")}
              </span>
              {s.title}
            </h2>
            <p className="text-pw-muted-on-paper leading-relaxed">{s.body}</p>
            <CodeBlock
              code={s.code.src}
              language={s.code.language}
              caption={s.code.caption}
            />
          </li>
        ))}
      </ol>

      <Callout variant="info" title="Next steps">
        Browse the full{" "}
        <Link href="/docs/api" className="underline">
          API reference
        </Link>{" "}
        or the{" "}
        <Link href="/docs/skills" className="underline">
          release-held MCP source catalogue
        </Link>{" "}
        for unsupported private-source design review. It is not a supported
        agent setup.
      </Callout>
    </article>
  );
}
