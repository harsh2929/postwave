# ---------------------------------------------------------------------------
# Cloud-init (shared across app + worker nodes).
# ---------------------------------------------------------------------------
locals {
  app_user_data = <<-EOT
    #cloud-config
    package_update: true
    package_upgrade: true
    packages:
      - ca-certificates
      - curl
      - gnupg
      - ufw
      - fail2ban
    write_files:
      - path: /etc/sysctl.d/90-postwave.conf
        content: |
          net.core.somaxconn = 65535
          net.ipv4.tcp_max_syn_backlog = 65535
          vm.overcommit_memory = 1
    runcmd:
      - install -m 0755 -d /etc/apt/keyrings
      - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      - echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" > /etc/apt/sources.list.d/docker.list
      - apt-get update
      - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      - systemctl enable --now docker
      - ufw default deny incoming
      - ufw default allow outgoing
      - ufw allow 80,443/tcp
      - ufw --force enable
      - sysctl -p /etc/sysctl.d/90-postwave.conf
  EOT
}

# ---------------------------------------------------------------------------
# Application nodes. A single node is the default until a load balancer is
# added; increase app_node_count only alongside external traffic balancing.
# ---------------------------------------------------------------------------
resource "hcloud_server" "app" {
  count        = var.app_node_count
  name         = "${local.name_prefix}-app-${count.index + 1}"
  server_type  = "ccx23"
  image        = "ubuntu-24.04"
  location     = var.region
  ssh_keys     = var.ssh_keys
  user_data    = local.app_user_data
  labels       = merge(local.common_labels, { role = "app" })
  firewall_ids = [hcloud_firewall.app.id]

  network {
    network_id = hcloud_network.main.id
    ip         = "10.10.1.${10 + count.index}"
  }
}

# ---------------------------------------------------------------------------
# Postgres node — 1x CCX33 (8 vCPU, 32 GB), only when use_neon = false.
# ---------------------------------------------------------------------------
resource "hcloud_server" "postgres" {
  count        = var.use_neon ? 0 : 1
  name         = "${local.name_prefix}-postgres"
  server_type  = "ccx33"
  image        = "ubuntu-24.04"
  location     = var.region
  ssh_keys     = var.ssh_keys
  user_data    = local.app_user_data
  labels       = merge(local.common_labels, { role = "postgres" })
  firewall_ids = [hcloud_firewall.db[0].id]

  network {
    network_id = hcloud_network.main.id
    ip         = "10.10.1.5"
  }
}

# ---------------------------------------------------------------------------
# Redis node — 1x CCX13 (2 vCPU, 8 GB).
# ---------------------------------------------------------------------------
resource "hcloud_server" "redis" {
  name         = "${local.name_prefix}-redis"
  server_type  = "ccx13"
  image        = "ubuntu-24.04"
  location     = var.region
  ssh_keys     = var.ssh_keys
  user_data    = local.app_user_data
  labels       = merge(local.common_labels, { role = "redis" })
  firewall_ids = [hcloud_firewall.redis.id]

  network {
    network_id = hcloud_network.main.id
    ip         = "10.10.1.6"
  }
}

# ---------------------------------------------------------------------------
# Bastion — 1x CX22 (smallest), the only host with public SSH.
# ---------------------------------------------------------------------------
resource "hcloud_server" "bastion" {
  name         = "${local.name_prefix}-bastion"
  server_type  = "cx22"
  image        = "ubuntu-24.04"
  location     = var.region
  ssh_keys     = var.ssh_keys
  labels       = merge(local.common_labels, { role = "bastion" })
  firewall_ids = [hcloud_firewall.bastion.id]

  network {
    network_id = hcloud_network.main.id
    ip         = "10.10.1.2"
  }
}
