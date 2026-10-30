# Campaign sending domain and capture mailboxes

**Purpose:** bring up the sending path that P0.6 of the
[Agent Legibility blueprint](../moosewave-ai-inbox-campaign-assurance-implementation-blueprint-2026-08-09.md)
needs — a certified `multipart/alternative` send from a domain we control,
received and inspected in mailboxes we own.

**Status:** infrastructure written and inert. Nothing in this runbook has been
applied. Every value below is a placeholder; supply real ones in a tfvars file
or your deployment's secret store.

---

## What the audit found

Recorded because two of these invert the plan, and one is a live gap.

### SES production access is per REGION, and one region's denial is not the account's

The account is not uniformly sandboxed. A production-access request was
**denied** in one region, and that region is the Terraform default provider
region for the marketing site — so the apex SES identity created there cannot
send beyond 200/day to verified recipients only. Other regions in the same
account already hold production access with a materially larger quota.

The blueprint's Weeks 1–3 assumed "request SES production access" was the long
pole. It is not. The work is **pointing the application at a region that
already has it**, and never assuming the account has one global state.

Check, always, before pointing anything at a region:

```bash
aws sesv2 get-account --region <region> --query ProductionAccessEnabled
```

A sandboxed region does not fail loudly. It caps the quota and silently refuses
unverified recipients, which presents as a deliverability problem rather than a
configuration one.

### The application is not wired to SES at all

`AWS_SES_REGION` and `POSTWAVE_MAILER` are both empty in the local environment,
so the API runs on the dev mailer. The committed ECS task definition points at a
region and a configuration set that **do not exist in this account** — it is an
illustrative template, not a description of anything deployed.

### Provider event receipts currently go nowhere

The existing SES configuration set has an SNS event destination whose only
subscriber is an **ephemeral `trycloudflare.com` development tunnel**. That
hostname is not stable. Every bounce, complaint, and delivery notification
published today is delivered to a dead endpoint or, worse, to whoever holds that
subdomain next.

This matters beyond hygiene: Campaign Assurance binds an outbound MIME hash to a
provider receipt. With no reachable event destination, a delivery attempt is
created that can never be reconciled, and the engagement ledgers that F01
depends on stay empty while looking merely quiet.

**Re-point that subscription before any live send.**

### The existing event destination omits the events the engagement work needs

It subscribes to bounce, complaint, delivery, reject, and rendering-failure. It
does not subscribe to **open, click, delivery-delay, or subscription** events.
The engagement classifier needs the provider's own view of opens and clicks to
separate human interaction from proxy and scanner traffic; without them, F01
classifies against application-side signals only.

### DNS is Terraform-managed, and a bare apply is destructive

Every moosewave.com record — SPF, DMARC, DKIM, MX, BIMI, autodiscover — is
managed by `sites/moosewave/infra`, a **nested standalone git repository** with
**local Terraform state**. DNS records are gated on `local.manage_dns`, which is
`var.hosted_zone_id != ""`. The variable defaults to empty.

**A bare `terraform apply` therefore plans the destruction of every DNS record,
including the MX that carries inbound mail.** Always pass the zone explicitly:

```bash
terraform plan -var hosted_zone_id=<zone-id> [-var-file=campaign-sending.tfvars]
```

Never manage these records with the AWS CLI. A CLI-created record is drift, and
the next apply removes it.

---

## What is already in place

- Apex domain verified for sending in the production-access region, Easy DKIM
  `SUCCESS`, feedback forwarding on.
- SPF and a `p=quarantine; sp=quarantine; pct=100` DMARC record on the apex.
  The `sp=` policy means **subdomains inherit quarantine** — see the warning in
  step 2.
- A configuration set with reputation metrics enabled and an SNS destination
  (subscriber broken, events incomplete — see above).

## What is missing

- A dedicated campaign sending subdomain (campaign volume currently shares
  reputation with corporate mail and waitlist confirmations).
- A custom MAIL FROM domain. Without one the Return-Path is an `amazonses.com`
  address: SPF contributes nothing to DMARC alignment, and VERP reply
  correlation has no envelope token to recover, which blocks F05.
- Capture mailboxes at the four providers.

---

## Step 1 — activate the sending domain

`sites/moosewave/infra/campaign-sending.tf` defines the identity, DKIM records,
custom MAIL FROM, policy records, and configuration set. Everything counts to
zero while `campaign_sending_subdomain` is empty.

Create `campaign-sending.tfvars`:

```hcl
campaign_sending_subdomain   = ""   # e.g. "send" → send.<domain>
campaign_sending_region      = ""   # MUST have ProductionAccessEnabled = true
campaign_bounce_subdomain    = "bounce"
campaign_event_sns_topic_arn = ""   # leave empty until step 3
campaign_dmarc_report_address = ""  # defaults to the apex rua
```

Then, from `sites/moosewave/infra`:

```bash
terraform plan -var hosted_zone_id=<zone-id> -var-file=campaign-sending.tfvars
```

**Read the plan before applying.** It must show only creates. Any destroy means
`hosted_zone_id` did not reach Terraform.

### Why `behavior_on_mx_failure = REJECT_MESSAGE`

The alternative, `USE_DEFAULT_VALUE`, silently reverts the Return-Path to
`amazonses.com` when the MAIL FROM MX is missing. That is the "looks fine, is
wrong" failure mode this whole programme exists to eliminate: alignment quietly
degrades and nobody learns until a DMARC report weeks later. Rejecting surfaces
a DNS regression on the first send.

## Step 2 — confirm the DMARC posture

The apex publishes `sp=quarantine`, which subdomains inherit. Publishing an
explicit `_dmarc` record on the sending subdomain **overrides** that
inheritance.

A `p=none` record there would be a **downgrade** — it would leave the
highest-volume sending domain in the account less protected than the corporate
one. The template publishes `p=quarantine` and changes only the reporting
address. Do not relax it for warm-up.

## Step 3 — fix and extend the event destination

1. Create or identify a durable HTTPS endpoint for SES notifications. It must be
   a stable hostname the API serves, not a development tunnel.
2. Re-point the SNS subscription to it and delete the tunnel subscription.
3. Set `campaign_event_sns_topic_arn` in the tfvars and re-apply, which attaches
   the full event set (adds open, click, delivery-delay, and subscription).
4. Add the topic ARN to `POSTWAVE_SES_TOPIC_ARNS`. The API rejects notifications
   from unlisted topics, so a topic wired in the console but absent from this
   list delivers nothing and logs a rejection.

## Step 4 — point the application at it

In the API environment (see `apps/api/.env.example`, which now documents each):

```
POSTWAVE_MAILER=ses
AWS_SES_REGION=<the production-access region>
POSTWAVE_SES_CONFIGURATION_SET=<configuration set from step 1>
POSTWAVE_SES_TOPIC_ARNS=<topic ARN from step 3>
POSTWAVE_SENDING_VERP_REPLY_TO=<address on the custom MAIL FROM domain>
```

Leave `POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT=off` for now. **The raw-MIME
send path only activates at `block`** — below that the legacy HTML sender still
runs. A staged rollout changes what is *enforced*, not what is *sent*, until it
reaches `block`. Do not jump straight there.

## Step 5 — capture mailboxes

P0.6 needs proof that a real provider receives valid `multipart/alternative`
with plain text first and HTML second. That requires receiving accounts we own
at each provider whose behaviour differs.

Four are needed, because provider domain and reading client are independent and
each combination behaves differently:

| Provider | Why it is distinct |
|---|---|
| Gmail | Tab classification, clipping, and the Gemini summary surface |
| Apple iCloud | Mail Privacy Protection pre-fetches remote content on receipt |
| Outlook | Different MIME normalisation and link rewriting |
| Yahoo | Independent authentication and reputation handling |

Each account needs, recorded in the seed registry rather than in a person's
notes: provider, client app, OS/device, account tier, locale, smart-feature
settings, and IMAP credentials held by reference only.

**These accounts must be created by a human.** Provider sign-up requires phone
verification and acceptance of terms, and automating it violates those terms.
Once created:

1. Store credentials in the secret store; the registry holds **references
   only** — migration 1930's registry is secret-reference-based by design.
2. Register each in the controlled seed registry with its full capability key.
3. Confirm `IMAP` connectivity through the deliverability service's connector,
   which uses bounded `BODY.PEEK[]` and must never set `\Seen`.

Until these exist, P0.6, P0.7, P3.2, and P3.4 all remain open regardless of what
the sending side can do — there is nothing to receive into.

---

## Verification before declaring the sending path ready

```bash
# 1. Region really has production access
aws sesv2 get-account --region <region> --query ProductionAccessEnabled

# 2. Identity verified and DKIM signing
aws sesv2 get-email-identity --email-identity <send.domain> --region <region> \
  --query '{DKIM:DkimAttributes.Status,MailFrom:MailFromAttributes,Verified:VerifiedForSendingStatus}'

# 3. MAIL FROM resolves (REJECT_MESSAGE means a missing MX stops sending)
dig +short MX bounce.<send.domain>

# 4. Event destination carries the full set
aws sesv2 get-configuration-set-event-destinations \
  --configuration-set-name <set> --region <region>

# 5. The SNS subscription points somewhere durable
aws sns list-subscriptions-by-topic --topic-arn <arn> --region <region>
```

A send is only evidence once a capture mailbox has the message and its received
MIME has been compared against the frozen artifact. Provider acceptance is not
placement, and placement is not comprehension.
