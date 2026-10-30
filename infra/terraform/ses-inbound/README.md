# Inbound reply mail — SES receipt rule → S3 → the replies worker

This root module provisions the delivery path that inbound replies had no way
of taking. Before it existed, no `ReceiptRuleSet` appeared in any `.tf` in the
repository, so `apps/api/internal/replies` — the reply taxonomy, the
quoted-history stripping, the `replied` subscriber event — was reachable only
from a caller that did not exist.

```
MX reply.moosewave.com → inbound-smtp.<region>.amazonaws.com
  → receipt rule set  postwave-<env>-inbound
    → rule            postwave-<env>-replies
      → S3 action     s3://postwave-<env>-inbound-mail-<account>/inbound/<ses-message-id>
      → SNS notify    postwave-<env>-inbound-mail
        → HTTPS       API Gateway (adds X-Postwave-SES-Inbound-Secret)
          → POST /api/internal/webhooks/inbound/ses
            → replies.InboundObjectWorker.ProcessObject
              → StripQuotedHistory + ClassifyReplyWithEvidence + Store.Persist
```

## Why a separate root module

`../` is the archived Hetzner + Cloudflare prototype; its README says so in its
first line and states that it is excluded from the release platform contract.
The canonical deployment is AWS `us-west-2`
([`../../aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../../aws/PRODUCTION_DEPLOY_RUNBOOK.md)).
Putting a production mail path in that root would put it behind the same
`terraform apply` that plans destroys of prototype Hetzner servers. Separate
root, separate state, separate blast radius.

Conventions are inherited, not reinvented: `local.name_prefix` and the
`project` / `environment` / `managed_by` tag keys come from `../main.tf`; the
S3 encryption / public-access-block / lifecycle shape and the constructed
receipt-rule ARN come from `../../../sites/moosewave/infra/mail-forward.tf`,
this repository's only other SES-inbound-to-S3 wiring; the AWS provider pin
(`~> 5.70`) is the same one.

## Personal data

Every object in the bucket is a message a named human wrote. Retention is
bounded by `aws_s3_bucket_lifecycle_configuration.inbound_mail`
(`inbound_mail_retention_days`, 7–90, default 30) — S3 is a processing buffer,
not an archive. Bucket versioning is deliberately **not** enabled: noncurrent
versions survive an expiration rule, so versioning would quietly convert
bounded retention into unbounded retention. The durable record is the bounded
snippet on `campaign_replies`, which has its own retention.

The SNS notification carries mail headers (subject, From, To), so the topic is
encrypted with a customer-managed KMS key. `alias/aws/sns` will not work: its
policy cannot be edited to admit the SES service principal.

## Bootstrap

1. Create the state bucket once, out of band, then:

   ```
   terraform init -backend-config=backend.hcl
   ```

   `backend.hcl` holds `bucket` and `region`; the key and `encrypt` are pinned
   in `main.tf`.

2. Copy `terraform.tfvars.example` → `terraform.tfvars` and fill it in.
   **Never commit `terraform.tfvars`** — the repo `.gitignore` already covers
   `*.tfvars`.

3. First apply with `activate_receipt_rule_set = false` and
   `inbound_notification_endpoint = ""`.

4. Publish DNS in Cloudflare (not managed here):

   - `TXT  _amazonses.<reply_domain>` ← `reply_domain_verification_token`
   - `MX   <reply_domain>`            ← `reply_domain_mx_record`

   Wait for the SES identity to report verified before continuing; SES will
   not accept mail for an unverified domain, and the `us-west-2` **sending**
   identity from `../../aws/ses-domain-setup.md` does not cover this
   subdomain.

5. Stand up the API Gateway stage that injects
   `X-Postwave-SES-Inbound-Secret`, set `inbound_notification_endpoint` to it,
   and apply. SNS cannot attach a custom header to an HTTPS subscription, and
   the SES receiver in `apps/api/internal/replies/handlers.go` rejects an
   unsigned delivery — subscribing the API origin directly produces a topic
   whose every delivery 401s.

6. Confirm the subscription. It is created pending, and the API answers `200`
   to a `SubscriptionConfirmation` without confirming it, so this is manual:

   ```
   aws sns list-subscriptions-by-topic --topic-arn <inbound_mail_topic_arn>
   ```

   then fetch the `SubscribeURL` from the pending confirmation delivery.

7. Only when everything above is verified, flip
   `activate_receipt_rule_set = true`.

   **This is destructive.** An AWS account has exactly one active receipt rule
   set per region. Activating this one deactivates whatever holds the slot
   today, and every rule in that set stops receiving mail the moment the apply
   lands. Terraform reports a clean create and says nothing. Check first:

   ```
   aws ses describe-active-receipt-rule-set --region us-west-2
   ```

## Wiring the API

| Output                           | API environment variable            |
|----------------------------------|-------------------------------------|
| `inbound_mail_bucket`            | `POSTWAVE_REPLIES_INBOUND_BUCKET`   |
| `inbound_mail_topic_arn`         | `POSTWAVE_SES_TOPIC_ARNS` (append)  |
| —                                | `POSTWAVE_REPLIES_SES_SHARED_SECRET`|
| `reply_domain` (variable)        | `POSTWAVE_REPLIES_ENVELOPE_DOMAIN`  |

`inbound_mail_reader_policy_arn` is the read-only S3 grant the worker needs.
Set `worker_role_name` to attach it to the ECS task role automatically, or
attach it by hand — the task role is created by
`../../aws/cloudformation/postwave-stack.yaml`, so this module does not claim
ownership of it.

## Files

| File                       | Purpose                                              |
|----------------------------|------------------------------------------------------|
| `main.tf`                  | Provider, backend, locals, constructed rule ARN.     |
| `variables.tf`             | All input variables.                                 |
| `inbound_mail.tf`          | Bucket, policies, KMS, SNS, rule set, rule, IAM.     |
| `outputs.tf`               | Bucket, topic, DNS records, policy ARN.              |
| `terraform.tfvars.example` | Copy this to `terraform.tfvars`.                     |

## Validation

```
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
```

`-backend=false` keeps validation credential-free. `terraform plan` and
`terraform apply` need real AWS credentials and are not part of the checked-in
gate.
