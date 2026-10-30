terraform {
  required_version = ">= 1.7.0"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }

  # State backend: Hetzner Object Storage (S3-compatible). Configure via
  # `terraform init -backend-config=backend.hcl` to keep secrets out of the
  # repo. See README.md for the bootstrap procedure.
  backend "s3" {
    bucket                      = "postwave-tfstate"
    key                         = "infra/terraform.tfstate"
    region                      = "eu-central"
    endpoint                    = "https://nbg1.your-objectstorage.com"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    force_path_style            = true
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  name_prefix = "postwave-${var.environment}"
  common_labels = {
    project     = "postwave"
    environment = var.environment
    managed_by  = "terraform"
  }
}
