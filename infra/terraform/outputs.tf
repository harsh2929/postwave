output "app_node_ips" {
  description = "Public IPv4 addresses of the application nodes."
  value       = [for s in hcloud_server.app : s.ipv4_address]
}

output "bastion_ip" {
  description = "Public IPv4 of the SSH bastion."
  value       = hcloud_server.bastion.ipv4_address
}

output "redis_private_ip" {
  description = "Private (network) IP of the Redis node."
  value       = "10.10.1.6"
}

output "postgres_ip" {
  description = "Private IP of the self-hosted Postgres node, when use_neon=false."
  value       = var.use_neon ? null : "10.10.1.5"
}

output "r2_bucket_endpoints" {
  description = "S3-compatible endpoints for the R2 buckets."
  value = {
    media         = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com/${cloudflare_r2_bucket.media.name}"
    backups       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com/${cloudflare_r2_bucket.backups.name}"
    dmarc_reports = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com/${cloudflare_r2_bucket.dmarc_reports.name}"
  }
}
