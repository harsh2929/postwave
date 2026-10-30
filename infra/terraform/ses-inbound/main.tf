# Inbound reply mail — SES receipt rule → S3 → the replies worker.
#
# WHY THIS IS ITS OWN ROOT MODULE
#
# `../` (infra/terraform) is the archived Hetzner + Cloudflare prototype. Its
# own README opens with "NON-PRODUCTION — archived Hetzner Terraform
# prototype" and states it is "intentionally excluded from the release platform
# contract". The canonical deployment is AWS `us-west-2`
# (infra/aws/PRODUCTION_DEPLOY_RUNBOOK.md), so the inbound-mail path cannot live
# there: putting a production mail path in that root would put it behind the
# same `terraform apply` that plans destroys of prototype Hetzner servers, and
# would saddle it with that root's Hetzner/Cloudflare credential requirements.
#
# A separate root means a separate state file and therefore a separate blast
# radius. Conventions are inherited rather than reinvented:
#
#   - naming     — `local.name_prefix = "postwave-${var.environment}"`, the
#                  same expression as ../main.tf.
#   - tagging    — the same three tag keys ../main.tf puts in `common_labels`
#                  (project / environment / managed_by), applied through the
#                  AWS provider's `default_tags` the way
#                  sites/moosewave/infra/main.tf does.
#   - variables  — description + type on every variable, `validation` blocks for
#                  closed sets, `sensitive` on secrets (../variables.tf).
#   - buckets    — encryption, public-access blocking and lifecycle each
#                  declared as their own resource, as in
#                  sites/moosewave/infra/mail-forward.tf, which is this
#                  repository's only existing SES-inbound-to-S3 wiring.
#
# The AWS provider pin matches the only other AWS Terraform in the repository
# (sites/moosewave/infra/main.tf): `~> 5.70`.

terraform {
  # >= 1.5.0 rather than ../main.tf's >= 1.7.0, matching
  # sites/moosewave/infra/main.tf. Nothing here uses a post-1.5 feature (no
  # check blocks, no removed blocks, no provider-defined functions), and the
  # lower floor is what lets `terraform validate` actually run on the pinned
  # 1.5.7 toolchain rather than being asserted from a README.
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # State backend. Configure via `terraform init -backend-config=backend.hcl` to
  # keep the bucket name and credentials out of the repo — the same bootstrap
  # ../README.md documents. Left as a partial configuration on purpose:
  # `terraform init -backend=false` must keep working offline so that
  # `terraform validate` needs no credentials.
  backend "s3" {
    key     = "infra/ses-inbound/terraform.tfstate"
    encrypt = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "postwave"
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name_prefix = "postwave-${var.environment}"

  rule_set_name = "${local.name_prefix}-inbound"
  rule_name     = "${local.name_prefix}-replies"

  # Every object SES writes lands under this prefix. The bucket policy, the
  # lifecycle rule and the worker's read grant are all scoped to it, so a future
  # non-mail use of this bucket cannot silently inherit SES's write grant or the
  # worker's read grant.
  object_key_prefix = "inbound/"

  # Built as a string rather than referenced. The bucket policy must name the
  # receipt rule (that is the entire point of the SourceArn condition) and the
  # receipt rule must not be created until the policy lets SES write, so a
  # reference in either direction is a dependency cycle. Same technique, and the
  # same reason, as sites/moosewave/infra/mail-forward.tf.
  receipt_rule_arn = join("", [
    "arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}",
    ":receipt-rule-set/${local.rule_set_name}",
    ":receipt-rule/${local.rule_name}",
  ])
}
