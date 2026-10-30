resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_names.media
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_names.backups
  location   = "WEUR"
}

resource "cloudflare_r2_bucket" "dmarc_reports" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_names.dmarc_reports
  location   = "WEUR"
}

# Email-block / template asset uploads (POSTWAVE_UPLOADS_BUCKET).
resource "cloudflare_r2_bucket" "assets" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_names.assets
  location   = "WEUR"
}

# Long-term archived content, served publicly at ARCHIVE_PUBLIC_BASE_URL.
resource "cloudflare_r2_bucket" "archive" {
  account_id = var.cloudflare_account_id
  name       = var.r2_bucket_names.archive
  location   = "WEUR"
}
