# © Moosewave. Proprietary and confidential.
#
# Terraform module that provisions the customer-side resources the
# Moosewave Audit Shareback Native App needs:
#
#   * snowflake_database / snowflake_schema for POSTWAVE_AUDIT
#   * snowflake_storage_integration that grants the Snowflake account
#     read-only access to Moosewave's S3 archive bucket subtree the
#     listing entitlement covers
#   * snowflake_external_stage backed by that integration
#   * snowflake_task that calls POSTWAVE_AUDIT.RUN_COPY() on the
#     supplied cron
#
# Apply once, then bind `external_stage` in the Native App install
# wizard. Moosewave-side changes (rotating the bucket access keys,
# changing the prefix) happen via the audit-sink Patch endpoint; this
# module does not need to be re-applied.

terraform {
  required_providers {
    snowflake = {
      source  = "Snowflake-Labs/snowflake"
      version = ">= 0.95.0"
    }
  }
}

variable "account_locator" {
  type        = string
  description = "Snowflake account locator, e.g. xy12345.eu-central-1.aws"
}

variable "share_name" {
  type        = string
  default     = "POSTWAVE_AUDIT_SHARE"
  description = "Name of the share the Native App publishes."
}

variable "postwave_archive_bucket" {
  type        = string
  description = "Moosewave-owned S3 bucket the listing reads from. Provided by Moosewave at onboarding."
}

variable "postwave_archive_prefix" {
  type        = string
  default     = "audit"
  description = "Prefix inside the bucket. Must match the prefix on the Moosewave-side audit_sink."
}

variable "poll_cron" {
  type        = string
  default     = "USING CRON */5 * * * * UTC"
  description = "How often Snowflake should COPY new files. Default: every 5 minutes."
}

resource "snowflake_database" "audit" {
  name    = "POSTWAVE_AUDIT_DB"
  comment = "Moosewave audit shareback landing database."
}

resource "snowflake_schema" "audit" {
  database = snowflake_database.audit.name
  name     = "POSTWAVE_AUDIT"
}

resource "snowflake_storage_integration" "postwave" {
  name              = "POSTWAVE_AUDIT_INTEGRATION"
  type              = "EXTERNAL_STAGE"
  enabled           = true
  storage_provider  = "S3"
  storage_aws_role_arn = "arn:aws:iam::${var.postwave_aws_account_id}:role/PostwaveSharebackRead"
  storage_allowed_locations = [
    "s3://${var.postwave_archive_bucket}/${var.postwave_archive_prefix}/${var.account_locator}/${var.share_name}/"
  ]
}

variable "postwave_aws_account_id" {
  type        = string
  description = "Moosewave's AWS account ID. Used to construct the cross-account read role."
}

resource "snowflake_stage" "archive" {
  name                = "STAGE"
  database            = snowflake_database.audit.name
  schema              = snowflake_schema.audit.name
  url                 = "s3://${var.postwave_archive_bucket}/${var.postwave_archive_prefix}/${var.account_locator}/${var.share_name}/"
  storage_integration = snowflake_storage_integration.postwave.name
  file_format         = "TYPE = JSON STRIP_OUTER_ARRAY = FALSE"
}

resource "snowflake_task" "poll_copy" {
  name      = "POSTWAVE_AUDIT_POLL"
  database  = snowflake_database.audit.name
  schema    = snowflake_schema.audit.name
  warehouse = var.warehouse_name
  schedule  = var.poll_cron
  sql_statement = "CALL POSTWAVE_AUDIT.RUN_COPY()"
  enabled   = true
}

variable "warehouse_name" {
  type        = string
  description = "Existing Snowflake warehouse the POLL_COPY task runs in."
}

output "share_name" {
  value       = var.share_name
  description = "Pass this back to Moosewave when you create the snowflake_shareback audit sink."
}

output "external_stage_fqn" {
  value       = "${snowflake_database.audit.name}.${snowflake_schema.audit.name}.${snowflake_stage.archive.name}"
  description = "FQN to bind to the Native App's external_stage reference."
}
