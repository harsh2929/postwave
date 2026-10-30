locals {
  app_lb_ip = hcloud_server.app[0].ipv4_address
}

# ---------------------------------------------------------------------------
# DNS records
# ---------------------------------------------------------------------------
resource "cloudflare_record" "apex" {
  zone_id = var.cloudflare_zone_id
  name    = "@"
  type    = "A"
  value   = local.app_lb_ip
  ttl     = 1
  proxied = true
}

resource "cloudflare_record" "api" {
  zone_id = var.cloudflare_zone_id
  name    = "api"
  type    = "A"
  value   = local.app_lb_ip
  ttl     = 1
  proxied = true
}

resource "cloudflare_record" "docs" {
  zone_id = var.cloudflare_zone_id
  name    = "docs"
  type    = "A"
  value   = local.app_lb_ip
  ttl     = 1
  proxied = true
}

resource "cloudflare_record" "status" {
  zone_id = var.cloudflare_zone_id
  name    = "status"
  type    = "A"
  value   = local.app_lb_ip
  ttl     = 1
  proxied = true
}

resource "cloudflare_record" "forms" {
  zone_id = var.cloudflare_zone_id
  name    = "forms"
  type    = "A"
  value   = local.app_lb_ip
  ttl     = 1
  proxied = true
}

# ---------------------------------------------------------------------------
# Managed WAF — OWASP Core Rule Set
# ---------------------------------------------------------------------------
resource "cloudflare_ruleset" "managed_waf" {
  zone_id     = var.cloudflare_zone_id
  name        = "owasp-core-ruleset"
  description = "Managed Cloudflare OWASP CRS"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    action      = "execute"
    description = "Cloudflare Managed Ruleset"
    expression  = "true"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee" # Cloudflare Managed Ruleset id
    }
  }

  rules {
    action      = "execute"
    description = "OWASP Core Ruleset"
    expression  = "true"
    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f" # OWASP CRS id
      overrides {
        action = "block"
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Custom rate-limit rules per route group
# ---------------------------------------------------------------------------
resource "cloudflare_ruleset" "rate_limits" {
  zone_id     = var.cloudflare_zone_id
  name        = "rate-limits"
  description = "Per-route-group rate limits"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action      = "block"
    description = "Throttle public form submissions"
    expression  = "(http.request.uri.path matches \"^/api/public/forms/[^/]+/submit$\")"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 10
      mitigation_timeout  = 600
    }
  }

  rules {
    action      = "block"
    description = "Throttle login endpoint"
    expression  = "(http.request.uri.path eq \"/api/v1/auth/login\")"
    ratelimit {
      characteristics     = ["ip.src"]
      period              = 60
      requests_per_period = 5
      mitigation_timeout  = 900
    }
  }
}

# ---------------------------------------------------------------------------
# DDoS L7 settings — enabled by default; this resource just asserts the
# preferred sensitivity.
# ---------------------------------------------------------------------------
resource "cloudflare_ruleset" "ddos_l7" {
  zone_id     = var.cloudflare_zone_id
  name        = "ddos-l7-overrides"
  description = "DDoS L7 sensitivity"
  kind        = "zone"
  phase       = "ddos_l7"

  rules {
    action      = "execute"
    description = "Cloudflare DDoS L7 Managed Ruleset"
    expression  = "true"
    action_parameters {
      id = "4d21379b4f9f4bb088e0729962c8b3cf"
      overrides {
        # Provider v4 models Cloudflare's maximum/default sensitivity as
        # "default"; "high" is not a valid API value for this override.
        sensitivity_level = "default"
      }
    }
  }
}
