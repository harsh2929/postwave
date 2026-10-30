# ses-domain-setup.md

Runbook for verifying `moosewave.com` in Amazon SES and wiring it into the
auth + transactional mailer pipeline. This is the gate on flipping
`POSTWAVE_MAILER=ses` in the task definition; until DKIM is verified and the
account is out of sandbox, magic-link sign-ins, password resets, and email
verification all silently fail (the dev mailer is the fallback in
`mailer.NewDevMailer`, but production should never run the dev mailer).

Region: `us-west-2`. Tenants whose `data_region` is not `us-west-2` need a
parallel SES setup in their region; this runbook covers the primary.

SES production access is granted per region, not per account, and a sandboxed
region does not fail loudly: it caps sending at 200 messages/day and silently
refuses unverified recipients, which reads as a deliverability problem. Before
any step below, confirm the region is out of the sandbox and record the result
in the release evidence:

```bash
aws sesv2 get-account --region us-west-2 --query ProductionAccessEnabled
```

If it prints `false`, request production access for this region (a case per
region) or set `AWS_SES_REGION` in the task definition to a region that already
has it; the API sends from `AWS_SES_REGION` and falls back to `AWS_REGION` only
when it is unset. As of 2026-09-12 this account has production access in
`eu-west-1` and `us-east-1` only; `us-west-2` still needs the request.

## 1. Add the sending identity

```bash
aws ses verify-domain-identity \
  --domain moosewave.com \
  --region us-west-2
```

This returns a `VerificationToken`. Add it as a TXT record at
`_amazonses.moosewave.com`. Verification typically lands within 30 minutes;
use `aws ses get-identity-verification-attributes` to confirm.

## 2. Enable DKIM signing

```bash
aws ses verify-domain-dkim \
  --domain moosewave.com \
  --region us-west-2
```

Returns three CNAME tokens. Add three CNAME records:

```
<token1>._domainkey.moosewave.com.  CNAME  <token1>.dkim.amazonses.com.
<token2>._domainkey.moosewave.com.  CNAME  <token2>.dkim.amazonses.com.
<token3>._domainkey.moosewave.com.  CNAME  <token3>.dkim.amazonses.com.
```

DKIM verification can take up to 72 hours; in practice it lands inside 1
hour with Cloudflare or Route 53. **Do not flip `POSTWAVE_MAILER=ses`
until `DkimVerificationStatus` is `Success`.** Sending from an unverified
domain works in sandbox (with verified recipients) but auth signups will
silently fail in production because every recipient is an unverified
customer.

## 3. SPF

Add a TXT record at the root:

```
moosewave.com.  TXT  "v=spf1 include:amazonses.com ~all"
```

Soft-fail (`~all`) for now; tighten to `-all` only after confirming nothing
else legitimately sends from `moosewave.com` (no marketing tools, no
bcc-blind feedback loops). The transition is one-way painless: `-all` is
spec-correct; `~all` is the cautious cutover.

## 4. DMARC

Start in `quarantine` mode with aggregate reporting:

```
_dmarc.moosewave.com.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@moosewave.com; ruf=mailto:dmarc@moosewave.com; fo=1; aspf=r; adkim=r"
```

Move to `p=reject` after 30 days of clean DMARC reports. The `dmarc@`
inbox needs an actual recipient -- a Group/alias forwarding to
`#deliverability` in Slack via an inbound parser is the standard pattern.

## 5. Configuration set

```bash
aws ses create-configuration-set \
  --configuration-set Name=postwave-prod \
  --region us-west-2

aws ses put-configuration-set-tracking-options \
  --configuration-set-name postwave-prod \
  --tracking-options CustomRedirectDomain=track.moosewave.com \
  --region us-west-2
```

The configuration set name (`postwave-prod`) is wired into the task
definition as `POSTWAVE_SES_CONFIGURATION_SET`. Every send carries that
header; SES then routes events through the event destinations below.

## 6. Event publishing -> SNS -> webhook

Two SPLIT topics, not one combined topic. The topic names below must match
`POSTWAVE_SES_TOPIC_ARNS` in `ecs-task-definition.json` /
`postwave-stack.yaml` EXACTLY: the webhook handler verifies the SNS
signature and then checks the delivering topic's ARN against that
allow-list, fail-closed. A topic with any other name (e.g. a combined
`postwave-prod-ses-events`) passes signature verification but is rejected
by the allow-list, and NO suppression rows are ever written — silently.

```
SES bounce                          SES complaint
    |                                   |
    v                                   v
SNS topic:                          SNS topic:
postwave-prod-ses-bounce            postwave-prod-ses-complaint
    \                                   /
     \                                 /
      v                               v
HTTPS subscriber: https://api.moosewave.com/api/internal/webhooks/deliverability/ses
```

Create both topics and one event destination per topic:

```bash
aws sns create-topic \
  --name postwave-prod-ses-bounce \
  --region us-west-2

aws sns create-topic \
  --name postwave-prod-ses-complaint \
  --region us-west-2

aws ses create-configuration-set-event-destination \
  --configuration-set-name postwave-prod \
  --event-destination Name=ses-bounce-sns,Enabled=true,MatchingEventTypes=bounce,SnsDestination={TopicARN=arn:aws:sns:us-west-2:<account>:postwave-prod-ses-bounce} \
  --region us-west-2

aws ses create-configuration-set-event-destination \
  --configuration-set-name postwave-prod \
  --event-destination Name=ses-complaint-sns,Enabled=true,MatchingEventTypes=complaint,SnsDestination={TopicARN=arn:aws:sns:us-west-2:<account>:postwave-prod-ses-complaint} \
  --region us-west-2
```

(Only bounce + complaint are routed: the handler records suppressions from
those two event types and explicitly ignores delivery/open/click, so
publishing other event types would only add SNS noise and cost.)

Then subscribe the API to BOTH topics:

```bash
for topic in postwave-prod-ses-bounce postwave-prod-ses-complaint; do
  aws sns subscribe \
    --topic-arn arn:aws:sns:us-west-2:<account>:${topic} \
    --protocol https \
    --notification-endpoint https://api.moosewave.com/api/internal/webhooks/deliverability/ses \
    --region us-west-2
done
```

The API endpoint is implemented at
`/api/internal/webhooks/deliverability/ses`. It verifies the SNS signature,
checks the topic allow-list, acknowledges subscription confirmations, unwraps
the SES event payload, and records bounce/complaint suppressions. Keep the SNS
subscription confirmation manual: the handler logs and acknowledges
`SubscriptionConfirmation`, but it does not auto-fetch `SubscribeURL` because
that would allow a hostile topic to trick the API into subscribing.

Required API env before enabling the subscription:

- `POSTWAVE_SES_TOPIC_ARNS` with the exact SNS topic ARN allow-list — BOTH
  ARNs, comma-separated:
  `arn:aws:sns:us-west-2:<account>:postwave-prod-ses-bounce,arn:aws:sns:us-west-2:<account>:postwave-prod-ses-complaint`.
- `POSTWAVE_INTERNAL_API_TOKEN` if the route is called through an internal
  proxy that injects internal auth headers.

## 7. Move out of sandbox

New SES accounts are sandboxed: 200 messages/day, recipients must be
verified. To send to real customers, file an AWS Support case under
`Service Quota Increase -> SES Sending Limits`:

- Use case: "Transactional mail for SaaS authentication (signup
  verification, password reset, magic link). No marketing."
- Expected daily volume: start at 50,000; raise as customer base grows.
- Bounce/complaint handling: link this runbook + the FBL config above.
- Compliance: link the privacy policy + DMARC record.

Approval typically takes 24-48 hours. Do not deploy the API with
`POSTWAVE_MAILER=ses` until the account shows
`production access: enabled` in the SES console.

## 8. From-address allowlist

The task role (`iam-policy-ecs-task-role.json`) restricts `ses:SendEmail`
via `ses:FromAddress` condition to:

- `noreply@moosewave.com` (auth + transactional)
- `support@moosewave.com` (replies)
- `billing@moosewave.com` (Stripe receipts)

Add new from-addresses to **both** the IAM condition and the SES
identity verification. Sending from an address not on the allowlist will
return `MessageRejected` at runtime, which surfaces as a bounce in the
feedback pipeline rather than a clear error.

## 9. Verification checklist

Before deploying with `POSTWAVE_MAILER=ses`:

- [ ] `aws ses get-identity-verification-attributes --identities moosewave.com` shows `VerificationStatus: Success`.
- [ ] `aws ses get-identity-dkim-attributes --identities moosewave.com` shows `DkimVerificationStatus: Success`.
- [ ] SPF, DMARC TXT records present and resolving (`dig TXT moosewave.com`, `dig TXT _dmarc.moosewave.com`).
- [ ] Test send to a Gmail + an Outlook + an iCloud address; inspect headers for `dkim=pass`, `spf=pass`, `dmarc=pass`.
- [ ] Configuration set `postwave-prod` exists with BOTH SNS event destinations wired (`ses-bounce-sns` -> `postwave-prod-ses-bounce`, `ses-complaint-sns` -> `postwave-prod-ses-complaint`).
- [ ] `/api/internal/webhooks/deliverability/ses` endpoint deployed and
  `POSTWAVE_SES_TOPIC_ARNS` lists BOTH topic ARNs, byte-for-byte identical
  to the topics created above (the handler string-compares ARNs).
- [ ] BOTH SNS subscriptions confirmed (status `Confirmed`, not `PendingConfirmation`).
- [ ] AWS support case for production access is approved.
- [ ] On-call has been briefed on the runbook for high-bounce-rate SES suspension (`docs/runbooks/deliverability-incident.md`).

Skipping any of these will bite later; the cost of the checklist is 30
minutes, the cost of "auth signups silently failing for 6 hours" is
measured in churned customers.
