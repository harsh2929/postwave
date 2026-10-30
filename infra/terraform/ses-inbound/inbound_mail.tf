# The inbound path, end to end:
#
#   MX reply.moosewave.com → inbound-smtp.<region>.amazonaws.com
#     → receipt rule set  postwave-<env>-inbound
#       → rule            postwave-<env>-replies
#         → S3 action     s3://postwave-<env>-inbound-mail-<account>/inbound/<ses-message-id>
#         → SNS notify    postwave-<env>-inbound-mail
#           → HTTPS       API Gateway (adds the shared secret)
#             → POST /api/internal/webhooks/inbound/ses
#               → replies.InboundObjectWorker.ProcessObject
#                 → StripQuotedHistory + ClassifyReplyWithEvidence + Store.Persist
#
# Before this file existed no ReceiptRuleSet appeared in any .tf in the
# repository, so the last five arrows had no first arrow: the reply taxonomy,
# the quoted-history stripping and the `replied` subscriber event were reachable
# only from a caller that did not exist.

# ── Relay buffer ────────────────────────────────────────────────────────────
#
# The bucket is a processing buffer, not an archive. SES has to write the
# message somewhere the product can read it; everything the product keeps
# afterwards lives on campaign_replies as a bounded snippet.

resource "aws_s3_bucket" "inbound_mail" {
  # Account-suffixed because S3 bucket names are globally unique across every
  # AWS customer, so "postwave-prod-inbound-mail" is a name someone else may
  # already hold and a first apply would fail on.
  bucket = "${local.name_prefix}-inbound-mail-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# SSE-S3 rather than SSE-KMS: SES writes inbound mail to an AES256 bucket with
# no extra key grant, whereas a KMS bucket requires the receipt rule to name the
# key and the key policy to admit SES, which is a failure mode that presents as
# silently unreceived mail. sites/moosewave/infra/mail-forward.tf made the same
# call for the same reason.
resource "aws_s3_bucket_server_side_encryption_configuration" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Bounded retention, because inbound mail is PERSONAL DATA.
#
# Every object here is a message a named human wrote: their address is in the
# headers and the body is whatever they chose to say to a company that emailed
# them. Without an expiration rule an S3 bucket keeps that forever, and "we
# still hold every reply anyone ever sent us" is not a state anyone chose — it
# is the state that arrives by default when nobody writes this block.
#
# Versioning is deliberately NOT enabled on this bucket. A versioned object's
# noncurrent versions survive the expiration rule below unless a second
# noncurrent rule is written, so versioning here would quietly convert bounded
# retention into unbounded retention.
resource "aws_s3_bucket_lifecycle_configuration" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id

  rule {
    id     = "expire-inbound-mail"
    status = "Enabled"

    filter {
      prefix = local.object_key_prefix
    }

    expiration {
      days = var.inbound_mail_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "inbound_mail_bucket" {
  statement {
    sid       = "AllowSESInboundWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.inbound_mail.arn}/${local.object_key_prefix}*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    # Both conditions matter, and neither is redundant. SourceAccount alone
    # would let ANY receipt rule in this account write here, including one
    # added later by a different team or by WorkMail. SourceArn is the precise
    # control AWS documents: only the one rule named in local.receipt_rule_arn
    # can put an object in this bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.receipt_rule_arn]
    }
  }

  # Narrowing, not widening: this denies plaintext access to everyone including
  # SES and the worker, both of which already speak TLS. The Allow above remains
  # the only grant in the policy.
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.inbound_mail.arn,
      "${aws_s3_bucket.inbound_mail.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound_mail" {
  bucket = aws_s3_bucket.inbound_mail.id
  policy = data.aws_iam_policy_document.inbound_mail_bucket.json

  # Ordering, not decoration: a bucket policy applied before public access is
  # blocked is a window in which the policy is evaluated without the block.
  depends_on = [aws_s3_bucket_public_access_block.inbound_mail]
}

# ── Notification ────────────────────────────────────────────────────────────
#
# The S3 action's topic_arn is how the worker learns an object exists. The
# notification carries the SES message id, the envelope recipients (which is
# where VERP lives — the To: header is not the envelope) and the spam/virus
# verdicts, none of which can be recovered from the stored bytes alone.

# The notification body contains mail headers: subject, From, To. That is
# personal data at rest inside SNS, so the topic is encrypted. A customer-
# managed key rather than alias/aws/sns because the AWS-managed key's policy
# cannot be edited to admit the SES service principal, and SES publishing to a
# topic it cannot encrypt for fails silently from the product's point of view.
resource "aws_kms_key" "inbound_notifications" {
  description             = "${local.name_prefix} inbound reply notifications (SNS)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.inbound_notifications_key.json
}

resource "aws_kms_alias" "inbound_notifications" {
  name          = "alias/${local.name_prefix}-inbound-mail"
  target_key_id = aws_kms_key.inbound_notifications.key_id
}

data "aws_iam_policy_document" "inbound_notifications_key" {
  # Without this statement the key is unmanageable: KMS does not grant the
  # account implicit access to its own key, and a key whose policy omits the
  # account root can never be modified again by anyone.
  statement {
    sid       = "AllowAccountAdministration"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowSESToPublishEncryptedNotifications"
    effect    = "Allow"
    actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic" "inbound_mail" {
  name              = "${local.name_prefix}-inbound-mail"
  kms_master_key_id = aws_kms_key.inbound_notifications.id
}

data "aws_iam_policy_document" "inbound_mail_topic" {
  statement {
    sid       = "AllowSESInboundPublish"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.inbound_mail.arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [local.receipt_rule_arn]
    }
  }
}

resource "aws_sns_topic_policy" "inbound_mail" {
  arn    = aws_sns_topic.inbound_mail.arn
  policy = data.aws_iam_policy_document.inbound_mail_topic.json
}

# The subscription lands in "pending confirmation" and stays there until the
# endpoint fetches its SubscribeURL. apps/api's SES receiver answers 200 to a
# SubscriptionConfirmation without confirming it (handlers.go: "the inbound
# webhook is wired only after confirmation"), so this is a deliberate manual
# step — see README.md.
resource "aws_sns_topic_subscription" "inbound_mail" {
  count = var.inbound_notification_endpoint == "" ? 0 : 1

  topic_arn = aws_sns_topic.inbound_mail.arn
  protocol  = "https"
  endpoint  = var.inbound_notification_endpoint

  # Raw delivery stays off: apps/api parses the SNS envelope (Type, TopicArn,
  # Message) before the SES notification inside it.
  raw_message_delivery = false
}

# ── Receiving identity ──────────────────────────────────────────────────────
#
# SES refuses to accept mail for a domain it has not verified IN THE RECEIVING
# REGION, and the sending identity from infra/aws/ses-domain-setup.md does not
# count for a subdomain. The verification token is an output; the TXT record it
# goes in is Cloudflare-managed and therefore outside this module.

resource "aws_ses_domain_identity" "reply" {
  domain = var.reply_domain
}

# ── Receipt rule ────────────────────────────────────────────────────────────

resource "aws_ses_receipt_rule_set" "inbound" {
  rule_set_name = local.rule_set_name
}

# DESTRUCTIVE WHEN ENABLED — see variables.tf. One active rule set per account
# per region; activating this one deactivates whatever holds the slot today.
resource "aws_ses_active_receipt_rule_set" "inbound" {
  count = var.activate_receipt_rule_set ? 1 : 0

  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name
}

resource "aws_ses_receipt_rule" "replies" {
  name          = local.rule_name
  rule_set_name = aws_ses_receipt_rule_set.inbound.rule_set_name

  # The whole reply domain, not an enumerated address list. Which local-part is
  # real is decided at runtime by the tenant resolver (replies-<slug>@…) and by
  # VERP (reply+<token>@…), so a new tenant needs no infrastructure change.
  recipients = [var.reply_domain]

  enabled = true

  # Optional rather than Require: requiring TLS rejects legitimate senders whose
  # servers still do not offer STARTTLS, and a rejected reply is a lost
  # engagement signal with no trace. Matches the tls_policy in
  # sites/moosewave/infra/mail-forward.tf.
  tls_policy = "Optional"

  # Produces the spamVerdict and virusVerdict the worker drops on. Without it a
  # domain-wide rule feeds every spam run at reply.moosewave.com straight into
  # the engagement metrics this whole subsystem exists to keep honest.
  scan_enabled = true

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.inbound_mail.id
    object_key_prefix = local.object_key_prefix
    topic_arn         = aws_sns_topic.inbound_mail.arn
  }

  # Not decoration. SES validates at CreateReceiptRule time that it can write to
  # the bucket and publish to the topic; created before the policies exist, the
  # rule is rejected.
  depends_on = [
    aws_s3_bucket_policy.inbound_mail,
    aws_sns_topic_policy.inbound_mail,
  ]
}

# ── Worker read grant ───────────────────────────────────────────────────────
#
# Read-only and prefix-scoped. The worker never deletes: retention is the
# lifecycle rule's job, and a worker that could delete could also lose mail it
# failed to ingest. Kept out of the bucket policy on purpose so that policy
# stays exactly "SES may write, nobody else may do anything".

data "aws_iam_policy_document" "inbound_mail_reader" {
  statement {
    sid       = "ReadInboundMailObjects"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.inbound_mail.arn}/${local.object_key_prefix}*"]
  }
}

resource "aws_iam_policy" "inbound_mail_reader" {
  name        = "${local.name_prefix}-inbound-mail-reader"
  description = "Read-only access to inbound reply objects for the replies worker."
  policy      = data.aws_iam_policy_document.inbound_mail_reader.json
}

# Attachment is optional because the task role is created by
# infra/aws/cloudformation/postwave-stack.yaml, not here. Naming it lets this
# module finish the wiring; leaving it empty keeps the policy available for
# manual attachment without this module claiming a role it does not own.
resource "aws_iam_role_policy_attachment" "inbound_mail_reader" {
  count = var.worker_role_name == "" ? 0 : 1

  role       = var.worker_role_name
  policy_arn = aws_iam_policy.inbound_mail_reader.arn
}
