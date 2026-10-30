# Moosewave user guide

How to actually use Moosewave once you have a workspace. Aimed at the
person running marketing for a company, not the engineer integrating
the API.

## What Moosewave is

A newsletter & lifecycle-marketing platform. You build subscriber lists,
write campaigns, automate journeys, and watch the metrics. It runs on
top of the open-source Listmonk delivery engine — Moosewave wraps it
with multi-workspace tooling, AI-authored sequences, deliverability
intel, and migration imports from Mailchimp / ConvertKit / Substack /
MailerLite / Beehiiv / CSV.

## The five pillars

1. **Subscribers** — your audience. Custom fields, tags, segments,
   suppression lists.
2. **Campaigns** — one-off broadcasts. Compose, schedule, send.
3. **Automations** — multi-step journeys triggered by events
   (signup, tag added, anniversary, …).
4. **Voice & sequences** — AI-generated email series matched to your
   writing style. Build a profile from samples, generate sequences
   from templates.
5. **Forms & landing pages** — capture surfaces that feed the audience.

## Day one: import your audience

Open the migration page (web admin → Migrations) and pick your source
platform. You'll need:

- **Mailchimp** — OAuth, followed by explicit audience selection
- **ConvertKit** — API key + API secret (Settings → Advanced)
- **Substack** — untouched official publication ZIP (preferred) or one current
  **All columns** subscriber CSV
- **MailerLite** — dedicated API token (Integrations → MailerLite API)
- **Beehiiv** — API key (Settings → Integrations)
- **CSV** — anything with `email` + optional `name`, tags, custom fields

Each migration job advertises source-specific coverage at runtime. A
verification report separates runtime imports, partial translations, preserved
rebuild evidence, and unsupported resources. Mailchimp Classic Automations can
import as executable runtime records that remain paused until review; Customer
Journey graphs require manual rebuild because the public API does not expose a
general graph export.

For Mailchimp, audience selection limits audience-bound contacts and merge
data, groups/interests, segments, signup-form and audience-schema evidence,
list-triggered Classic Automations, campaigns, and reports. Templates, landing
pages, and ecommerce evidence are account-wide; other source-archive guidance
is account-global or non-detected, and all of it is labeled before commit.
Self-hosted live commit requires dedicated Listmonk mode with the configured
dedicated tenant ID exactly matching the authenticated workspace.

After import, expect:

- Subscribers in **Subscribers**
- Tags + segments in **Audience → Segments**
- Past campaigns under **Campaigns → Archive**
- Paid-tier metadata on relevant Substack subscribers; this is not live
  Stripe/Apple billing or a destination entitlement. ConvertKit uses its own
  explicitly supported Stripe path.

## Day two: build your voice

Voice is what makes Moosewave's AI generation actually sound like you.

1. Open **Voice → Sources** and add 5-15 of your past pieces.
   - Newsletter archive (auto-pulled if you migrated)
   - RSS feed (your blog)
   - X/Twitter archive (the `tweets.js` from the export)
   - Paste-in (any text you've written)

2. Click **Build profile**. Moosewave reads your samples, extracts tone,
   sentence patterns, vocabulary frequency, and persona. Takes ~10s.

3. The profile drives every AI generation: sequences, regenerated emails,
   automation messages.

You can rebuild any time — voice profiles are cheap and update with
your style.

## Sending your first campaign

1. **Campaigns → New**. Choose:
   - **Plain campaign** — single email, one audience
   - **A/B test** — two subject lines or two bodies, declare a winner
     metric (opens / clicks / conversions)
   - **From a sequence** — promote a generated sequence to a real send

2. Compose. The editor handles HTML or MJML. Click **Inbox preview**
   to see how it renders in Gmail, Outlook, Apple Mail, and 7 more
   clients before you send.

3. Pick your audience. All subscribers, a saved segment, or a list.

4. **Schedule** for a future time or **Send now**.

   Moosewave's send orchestrator gates on your warmup tier — if your
   audience exceeds today's cap, you'll see a clear error telling you
   to narrow the segment or wait until tomorrow.

5. Track delivery from the campaign report (Campaigns → click the row).
   Opens, clicks, top URLs, bounces, complaints — all live, no cron lag.

## Automations

Automations are journeys: subscribers enter, traverse a graph of
nodes, and exit (or never exit, in long-running drips).

Node types:

- **Wait** — pause for a duration (24h, 3 days, ...)
- **Branch** — conditional split on subscriber attributes or segment
  membership
- **Action** — send an email, add a tag, move to a list, unsubscribe

Triggers:

- New subscriber added
- Tag added / removed
- Segment membership changes
- Custom event (via API)

Build it visually, save as draft, then flip to **Active**. Live
journeys can be paused mid-flight for editing — in-progress subscribers
finish their current step and the new graph kicks in for fresh
entries.

## Voice-generated sequences

The fastest path to "I have an onboarding series live by Friday":

1. **Voice → Templates** — pick a starter (Welcome 3-email, SaaS
   onboarding, re-engagement gentle, …). The library is 30+ deep.

2. Fill in the variables (product name, value prop, CTA URL, …).

3. **Generate**. Claude drafts each email, scores its voice fidelity
   against your profile (0-100, ≥80 is "sounds like you"), and shows
   you the result.

4. Tweak any individual email by clicking **Regenerate** with a hint
   ("punchier opening", "less corporate"). Voice fidelity recomputes.

5. **Promote to automation** to run it as a journey, or **Promote to
   campaign** to send it as a one-off broadcast.

## Forms

**Forms → New** to create an opt-in form. Two flavours:

- **Single opt-in** — submit → subscriber created enabled, no
  confirmation email.
- **Double opt-in** — submit → confirmation email → click → subscriber
  enabled. Standard for compliance (GDPR / CASL).

Embed via:

- Hosted page at `forms.postwave.app/<your-slug>`
- `<script src="...embed.js">` snippet for any HTML page
- Direct `POST` from your own JS

Submissions land in the form's submission log + auto-create subscribers.
Double-opt-in confirmations flow through the transactional outbox so
"submission saved but Listmonk never enabled" can never happen.

## Landing pages

For more than just an opt-in box: full landing pages with hero,
features, testimonials, embedded form. Author in the editor, publish,
get a `pages.postwave.app/<slug>` URL. Track conversions through the
embedded form's analytics.

## API + integrations

Everything in the UI is also a REST API call. Auth with an API key
(Settings → API keys). The key surface:

```
GET    /api/v1/subscribers
POST   /api/v1/subscribers
PATCH  /api/v1/subscribers/{id}
POST   /api/v1/subscribers/{id}/suppress

GET    /api/v1/campaigns/{id}/report
GET    /api/v1/dashboard/stats

POST   /api/v1/voice/sources
POST   /api/v1/voice/sequences           → returns job_id
GET    /api/v1/voice/sequences/jobs/{id} → poll

POST   /api/v1/webhooks                  → register an outbound listener
```

Full reference: `packages/openapi/openapi.yaml` (Swagger UI viewer at
`/api/docs` when running locally).

### Webhooks

Tell Moosewave to ping your URL on subscriber.created, .unsubscribed,
.bounced, campaign.sent, sequence.generated, etc. HMAC-SHA256 signed,
at-least-once with retry. Use them to:

- Sync to your CRM
- Slack-alert on big unsubscribes
- Trigger downstream automation in Zapier / n8n / your own backend

## Mobile app

iOS + Android via Expo. Pairs to a workspace by API key (mint one in
the web admin, paste it on the login screen). Surfaces:

- Dashboard tiles (subscribers, recent campaigns)
- Subscriber browse + search + suppress
- Campaign list with delivery stats
- Push notifications when subscribers unsubscribe / bounce / campaigns
  finish sending

Mobile is read-mostly by design — composing belongs on the web. The
killer mobile feature is **on-call notifications**: a tenant who
subscribes to `subscriber.unsubscribed` events sees the unsubscribes
the moment they happen, on the phone, with a tap-through to the
specific subscriber's detail.

## Deliverability

The **Deliverability** dashboard tracks:

- **Auth checks** — SPF, DKIM, DMARC for every domain you send from
- **Reputation** — Microsoft SNDS, Google Postmaster Tools, SenderScore
- **Inbox-reality** — predicted Inbox vs Promotions vs Spam placement
  per major mailbox provider
- **Render preview** — your campaign in Gmail / Outlook / Apple Mail
  / Yahoo / Outlook.com / etc., rendered before send

A "send anyway" button overrides warnings; a clear red banner appears
on the report afterward so you can correlate problems to that decision.

## Privacy & compliance

- **GDPR data export** — Settings → Privacy → Export. Request runs
  asynchronously; download link emailed when ready. Includes every
  table that has a `tenant_id` foreign key for the requesting subject.
- **GDPR erasure** — same screen, "Erase". Soft-delete with 30-day
  recovery window before hard purge.
- **Audit log** — every privileged write (key created, campaign sent,
  subscriber suppressed) is recorded with actor + tenant + timestamp.
  Queryable at Settings → Audit.

## Getting unstuck

- **Docs index:** `docs/`
- **Architecture overview:** `docs/ARCHITECTURE.md`
- **Self-host runbook:** `docs/aws-deployment-runbook.md`
- **API reference:** `packages/openapi/openapi.yaml`
- **Issues:** GitHub issues on the Moosewave repo
