resource "hcloud_network" "main" {
  name     = "${local.name_prefix}-net"
  ip_range = "10.10.0.0/16"
  labels   = local.common_labels
}

resource "hcloud_network_subnet" "private" {
  network_id   = hcloud_network.main.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = "10.10.1.0/24"
}

# ---------------------------------------------------------------------------
# Firewalls
# ---------------------------------------------------------------------------

# Bastion: SSH from operator IPs only.
resource "hcloud_firewall" "bastion" {
  name   = "${local.name_prefix}-bastion-fw"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.operator_ssh_cidrs
  }
}

# App nodes: 80/443 from the world; 22 from the bastion subnet only.
resource "hcloud_firewall" "app" {
  name   = "${local.name_prefix}-app-fw"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }
  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["10.10.1.0/24"]
  }
}

# Database (only created when use_neon = false).
resource "hcloud_firewall" "db" {
  count  = var.use_neon ? 0 : 1
  name   = "${local.name_prefix}-db-fw"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "5432"
    source_ips = ["10.10.1.0/24"]
  }
}

# Redis: app-subnet only.
resource "hcloud_firewall" "redis" {
  name   = "${local.name_prefix}-redis-fw"
  labels = local.common_labels

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "6379"
    source_ips = ["10.10.1.0/24"]
  }
}
