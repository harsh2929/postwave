# NON-PRODUCTION — archived Hetzner Terraform prototype

This directory is retained only as historical design material. It provisions
blank Docker hosts and does **not** deploy, migrate, secure, observe, back up or
roll back the Moosewave application. It is not supported for Moosewave Cloud or
client data and is intentionally excluded from the release platform contract.
The canonical deployment is the AWS CloudFormation path documented in
[`../aws/PRODUCTION_DEPLOY_RUNBOOK.md`](../aws/PRODUCTION_DEPLOY_RUNBOOK.md).

The historical prototype describes Hetzner Cloud + Cloudflare + optional Neon:

- 2× CCX23 application nodes (Docker; Moosewave services + Listmonk).
- 1× CCX13 Redis node (asynq + rate-limit cache).
- 1× CX22 SSH bastion (the only public SSH ingress).
- 1× CCX33 Postgres node — only when `use_neon = false`.
- Cloudflare DNS (apex + api + docs + status + forms subdomains).
- Cloudflare WAF (managed OWASP ruleset + custom rate-limit rules).
- Cloudflare R2 buckets (media, backups, dmarc-reports).

## Bootstrap procedure

1. Create the state bucket (one-off, manual):

   ```
   aws --endpoint-url https://nbg1.your-objectstorage.com s3 mb s3://postwave-tfstate
   ```

2. Drop credentials into `~/.aws/credentials` under a profile named
   `hetzner-objstor`, then create `backend.hcl`:

   ```
   access_key = "..."
   secret_key = "..."
   ```

3. Initialize:

   ```
   terraform init -backend-config=backend.hcl
   ```

4. Copy `terraform.tfvars.example` → `terraform.tfvars` and fill in real
   values. **Never commit `terraform.tfvars`** — it is in `.gitignore`.
   Set `operator_ssh_cidrs` to your office/VPN public CIDR blocks; the bastion
   firewall rejects broad SSH ingress such as `0.0.0.0/0`.

   The Terraform Docker provider uses strict SSH host key checking by default.
   Add the app host key to your known hosts file before deploys, for example:

   ```
   ssh-keyscan -H <app-node-public-ip> >> ~/.ssh/known_hosts
   ```

5. Plan + apply:

   ```
   terraform workspace new prod
   terraform plan -out plan.tfplan
   terraform apply plan.tfplan
   ```

## Workspaces (env promotion)

We use Terraform workspaces for staging vs. prod:

```
terraform workspace new staging   # one-time
terraform workspace select staging
terraform apply -var-file=staging.tfvars

terraform workspace select prod
terraform apply -var-file=prod.tfvars
```

Each workspace gets its own state file inside the same backend bucket.

## Files

| File                           | Purpose                                  |
|--------------------------------|------------------------------------------|
| `main.tf`                      | Provider blocks, backend, locals.        |
| `.terraform.lock.hcl`          | Archived provider versions and hashes.   |
| `variables.tf`                 | All input variables.                     |
| `network.tf`                   | Hetzner private network + firewalls.     |
| `compute.tf`                   | App / Postgres / Redis / bastion nodes.  |
| `cloudflare.tf`                | DNS + WAF + DDoS L7.                     |
| `r2.tf`                        | R2 buckets.                              |
| `outputs.tf`                   | Useful outputs (IPs, endpoints).         |
| `terraform.tfvars.example`     | Copy this to `terraform.tfvars`.         |

## Validation

Formatting or validation of this archived prototype is maintenance hygiene,
not a production release gate or deployment certification.
