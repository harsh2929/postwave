variable "hcloud_token" {
  description = "Hetzner Cloud API token (read-write)."
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token scoped to the Moosewave zone (Zone:Edit + DNS:Edit + WAF + Workers Routes)."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone id for moosewave.com."
  type        = string
}

variable "domain" {
  description = "Apex domain — usually moosewave.com."
  type        = string
  default     = "moosewave.com"
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

variable "region" {
  description = "Hetzner location code (nbg1 = Nuremberg, fsn1 = Falkenstein, hel1 = Helsinki)."
  type        = string
  default     = "nbg1"
}

variable "ssh_keys" {
  description = "List of Hetzner SSH key names to install on every server."
  type        = list(string)
}

variable "operator_ssh_cidrs" {
  description = "Operator office/VPN public CIDR blocks allowed to SSH to the bastion. Do not use 0.0.0.0/0 or ::/0."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.operator_ssh_cidrs) > 0
    error_message = "operator_ssh_cidrs must include at least one operator office/VPN CIDR."
  }

  validation {
    condition     = alltrue([for cidr in var.operator_ssh_cidrs : can(cidrhost(cidr, 0))])
    error_message = "operator_ssh_cidrs values must be valid CIDR blocks."
  }

  # Checked by PREFIX LENGTH, not by spelling. The previous form compared
  # against the two literal strings "0.0.0.0/0" and "::/0", which is a denylist
  # guarding SSH access to the bastion — and IPv6 has many spellings of the same
  # network. "::0/0", "0000::/0" and "0:0:0:0:0:0:0:0/0" are all the whole
  # internet, all valid CIDRs that pass the cidrhost() check above, and none of
  # them matched. A /0 is the whole internet however it is written, so that is
  # what gets tested.
  #
  # try(..., false) so a malformed value fails this validation too rather than
  # erroring: Terraform does not guarantee validation order, so this block
  # cannot assume the cidrhost() check ran first.
  validation {
    condition = alltrue([
      for cidr in var.operator_ssh_cidrs :
      try(tonumber(split("/", trimspace(cidr))[1]) > 0, false)
    ])
    error_message = "operator_ssh_cidrs must not allow SSH from the whole internet (a /0 prefix, in any notation)."
  }
}

variable "app_node_count" {
  description = "Number of CCX23 application nodes. Default is 1 until a load balancer is provisioned."
  type        = number
  default     = 1
}

variable "use_neon" {
  description = "When true, do NOT provision a Hetzner Postgres node; use Neon instead."
  type        = bool
  default     = true
}

variable "r2_bucket_names" {
  description = "Names of the R2 buckets to create."
  type = object({
    media         = string
    backups       = string
    dmarc_reports = string
    assets        = string
    archive       = string
  })
  default = {
    media         = "postwave-media"
    backups       = "postwave-backups"
    dmarc_reports = "postwave-dmarc"
    # assets  = email-block/template uploads served via POSTWAVE_UPLOADS_BUCKET.
    # archive = long-term archived content served at ARCHIVE_PUBLIC_BASE_URL.
    assets  = "postwave-assets"
    archive = "postwave-archive"
  }
}
