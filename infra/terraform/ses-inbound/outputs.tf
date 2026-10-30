output "inbound_mail_bucket" {
  description = "S3 bucket SES writes inbound reply mail to. Set as POSTWAVE_REPLIES_INBOUND_BUCKET."
  value       = aws_s3_bucket.inbound_mail.id
}

output "inbound_mail_object_key_prefix" {
  description = "Key prefix every inbound object lands under. The bucket policy, the lifecycle rule and the worker's read grant are all scoped to it."
  value       = local.object_key_prefix
}

output "inbound_mail_retention_days" {
  description = "Days before the lifecycle rule deletes an inbound message. Inbound mail is personal data; this is the bound on how long it is held."
  value       = var.inbound_mail_retention_days
}

output "inbound_mail_topic_arn" {
  description = "SNS topic carrying the SES S3-action notification. Add to POSTWAVE_SES_TOPIC_ARNS."
  value       = aws_sns_topic.inbound_mail.arn
}

output "receipt_rule_set_name" {
  description = "Receipt rule set holding the reply rule. Not active unless activate_receipt_rule_set is true."
  value       = aws_ses_receipt_rule_set.inbound.rule_set_name
}

output "receipt_rule_set_active" {
  description = "Whether this module activated the rule set. False means it exists but receives nothing."
  value       = var.activate_receipt_rule_set
}

output "inbound_mail_reader_policy_arn" {
  description = "Read-only IAM policy for the replies worker. Attach to the ECS task role when worker_role_name is left empty."
  value       = aws_iam_policy.inbound_mail_reader.arn
}

output "reply_domain_verification_token" {
  description = "Value for the _amazonses.<reply_domain> TXT record. SES will not accept mail for an unverified domain, and the sending identity in another region does not count."
  value       = aws_ses_domain_identity.reply.verification_token
}

output "reply_domain_mx_record" {
  description = "MX record content for reply_domain. Cloudflare-managed, so it is emitted rather than applied here."
  value       = "10 inbound-smtp.${var.region}.amazonaws.com"
}
