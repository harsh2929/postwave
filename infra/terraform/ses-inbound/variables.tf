variable "region" {
  description = "AWS region that terminates the reply domain's MX record. Must equal the region the SES sending identity lives in; infra/aws/ses-domain-setup.md fixes that at us-west-2."
  type        = string
  default     = "us-west-2"
}

variable "environment" {
  description = "Environment slug used for resource naming and tagging."
  type        = string
  default     = "prod"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev, staging, prod."
  }
}

variable "reply_domain" {
  description = "Domain whose MX points at SES and whose mail this rule receives, e.g. reply.moosewave.com. Must match POSTWAVE_REPLIES_ENVELOPE_DOMAIN so the replies handler can pull the tenant slug out of replies-<slug>@<domain>."
  type        = string
  default     = "reply.moosewave.com"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.reply_domain))
    error_message = "reply_domain must be a lowercase DNS name such as reply.moosewave.com."
  }
}

variable "inbound_mail_retention_days" {
  description = <<-EOT
    Days an inbound message stays in S3 before the lifecycle rule deletes it.

    Inbound mail is PERSONAL DATA: it is a message a named human wrote, with
    their address in the headers and whatever they chose to say in the body.
    S3 is a processing buffer here, not an archive — the durable record is the
    bounded snippet on campaign_replies, which has its own retention. Bounded
    on both ends so neither an unbounded archive nor a retention so short that
    a stalled worker loses mail can be configured by accident.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.inbound_mail_retention_days >= 7 && var.inbound_mail_retention_days <= 90
    error_message = "inbound_mail_retention_days must be between 7 and 90; inbound mail is personal data and must not accumulate indefinitely."
  }
}

variable "inbound_notification_endpoint" {
  description = <<-EOT
    HTTPS endpoint SES's S3-action notification is delivered to, which must be
    the API Gateway stage that injects the X-Postwave-SES-Inbound-Secret
    header — NOT the API origin. SNS cannot attach a custom header to an HTTPS
    subscription, and apps/api/internal/replies/handlers.go rejects an
    unsigned SES delivery, so subscribing the origin directly produces a topic
    whose every delivery 401s.

    Empty creates the topic and its policy but no subscription, which is the
    correct first apply: the gateway does not exist until something can be
    pointed at it.
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.inbound_notification_endpoint == "" || can(regex("^https://", var.inbound_notification_endpoint))
    error_message = "inbound_notification_endpoint must be empty or an HTTPS URL."
  }
}

variable "worker_role_name" {
  description = "Name of the ECS task role the API runs as (infra/aws/iam-policy-ecs-task-role.json). When set, the read-only inbound-mail policy is attached to it. Empty creates the policy and outputs its ARN for manual attachment, so this module never needs to own a role CloudFormation created."
  type        = string
  default     = ""
}

variable "activate_receipt_rule_set" {
  description = <<-EOT
    Whether to make this rule set the account's ACTIVE inbound rule set.

    DESTRUCTIVE WHEN TRUE. An AWS account has exactly one active receipt rule
    set per region, so activating this one DEACTIVATES whatever is active now
    — including a WorkMail-owned set — and every rule in it stops receiving
    mail the moment the apply lands. Terraform will not warn: the resource
    reports a clean create.

    Default false so the rule set can be created, reviewed and verified before
    anything that is already receiving mail is touched. Flip it deliberately,
    after confirming with
    `aws ses describe-active-receipt-rule-set --region <region>` that nothing
    else owns the slot.
  EOT
  type        = bool
  default     = false
}
