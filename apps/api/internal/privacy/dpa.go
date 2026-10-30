// SPDX-License-Identifier: AGPL-3.0-only
//
// dpa.go — Data Processing Agreement (DPA) download. GDPR Article 28
// requires the controller (the customer) to have a signed DPA with
// every processor (Moosewave) before transferring personal data. Our
// DPA is published as a stable template; the per-tenant download
// fills in the tenant's legal name + address + EU representative,
// stamps a SHA-256 hash for evidence, and emits a signed text/markdown
// bundle the operator can hand to procurement.

package privacy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// DPADeps wires the handler.
type DPADeps struct {
	Pool *db.Pool
	// Version is the DPA template version Moosewave publishes. Bumped
	// whenever the legal text changes; the tenant-facing download
	// echoes this so the customer can pin to a known version in
	// procurement.
	Version string
	// ProcessorName / Address are Moosewave's legal-entity strings.
	ProcessorName    string
	ProcessorAddress string
	// EUReprName / Address are Moosewave's Article 27 EU representative.
	EUReprName    string
	EUReprAddress string
}

// MountDPARoutes adds the read-only DPA endpoints under admin scope.
func MountDPARoutes(r chi.Router, d *DPADeps) {
	if d == nil {
		return
	}
	_ = chi.URLParam // keep chi import alive when no params are read directly
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/privacy/dpa", d.Metadata)
	r.With(apikeys.RequireScope(apikeys.ScopeAdmin)).Get("/api/v1/privacy/dpa/download", d.Download)
}

// DPAMetadata is the wire shape of the GET .../dpa endpoint.
type DPAMetadata struct {
	Version        string `json:"version"`
	GeneratedAt    string `json:"generated_at"`
	ProcessorName  string `json:"processor_name"`
	ControllerName string `json:"controller_name"`
	ControllerAddr string `json:"controller_address,omitempty"`
	BodySHA256     string `json:"body_sha256"`
	DownloadURL    string `json:"download_url"`
}

// Metadata returns JSON describing the DPA bundle.
func (d *DPADeps) Metadata(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	controller, addr, err := d.loadControllerIdentity(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "controller_lookup", "message": "an internal error occurred"},
		})
		return
	}
	body := d.renderDPA(controller, addr)
	sum := sha256.Sum256([]byte(body))
	writeJSON(w, http.StatusOK, DPAMetadata{
		Version:        d.versionOrDefault(),
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		ProcessorName:  d.processorNameOrDefault(),
		ControllerName: controller,
		ControllerAddr: addr,
		BodySHA256:     hex.EncodeToString(sum[:]),
		DownloadURL:    "/api/v1/privacy/dpa/download",
	})
}

// Download serves the rendered DPA body as text/markdown.
func (d *DPADeps) Download(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "no_tenant", "message": "tenant required"},
		})
		return
	}
	controller, addr, err := d.loadControllerIdentity(r.Context(), t.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"error": map[string]any{"code": "controller_lookup", "message": "an internal error occurred"},
		})
		return
	}
	body := d.renderDPA(controller, addr)
	sum := sha256.Sum256([]byte(body))
	filename := fmt.Sprintf("postwave-dpa-%s-%s.md",
		d.versionOrDefault(),
		strings.ReplaceAll(strings.ToLower(controller), " ", "-"),
	)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Body-SHA256", hex.EncodeToString(sum[:]))
	_, _ = w.Write([]byte(body))
}

// loadControllerIdentity reads the Controller (customer) name +
// postal address. Falls back to placeholders when workspace_settings
// hasn't been populated yet.
func (d *DPADeps) loadControllerIdentity(ctx context.Context, tenantID string) (name, addr string, err error) {
	if d.Pool == nil {
		return "", "", fmt.Errorf("dpa: pool not configured")
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// workspace_settings has NO address column and never has -- no migration
	// creates one. Selecting it made this query fail with 42703 on every call,
	// so GET /api/v1/privacy/dpa and its download have always answered 500. A
	// DPA is a compliance artifact; "has never once been generated" is the
	// worst state for it to be in.
	//
	// The address is left empty rather than invented. renderDPA already
	// substitutes "[Customer address — please update in Workspace Settings]"
	// for an empty one, and this function's own doc comment says it falls back
	// to placeholders when workspace_settings is unpopulated -- so the intended
	// behaviour was always "no stored address means a placeholder", and the
	// only defect is asking the database for a column that does not exist.
	//
	// Adding the column is a product decision (who sets it, is it validated, is
	// a placeholder legally sufficient) and does not belong in a bug fix. The
	// placeholder names the gap where a reader will see it.
	row := tx.QueryRow(ctx, `
SELECT COALESCE(t.name, '') AS tenant_name,
       COALESCE(ws.display_name, '') AS workspace_display
  FROM tenants t
  LEFT JOIN workspace_settings ws ON ws.tenant_id = t.id
 WHERE t.id = $1::uuid`, tenantID)
	var tenantName, workspaceName string
	workspaceAddr := ""
	if err := row.Scan(&tenantName, &workspaceName); err != nil {
		return "", "", err
	}
	name = workspaceName
	if name == "" {
		name = tenantName
	}
	if name == "" {
		name = "[Customer Legal Entity]"
	}
	addr = workspaceAddr
	return name, addr, nil
}

func (d *DPADeps) versionOrDefault() string {
	if d.Version == "" {
		return "2024-01"
	}
	return d.Version
}

func (d *DPADeps) processorNameOrDefault() string {
	if d.ProcessorName == "" {
		return "Moosewave, Inc."
	}
	return d.ProcessorName
}

// renderDPA produces the customer-facing DPA. The boilerplate maps
// 1:1 to standard GDPR Article 28 + UK GDPR processor terms; counsel
// reviews changes; bump d.Version when the text changes.
func (d *DPADeps) renderDPA(controllerName, controllerAddr string) string {
	processorAddr := d.ProcessorAddress
	if processorAddr == "" {
		processorAddr = "[Moosewave registered address]"
	}
	euRepr := ""
	if d.EUReprName != "" {
		euRepr = fmt.Sprintf("\n\n**EU Representative (Article 27, GDPR):** %s, %s.", d.EUReprName, d.EUReprAddress)
	}
	if controllerAddr == "" {
		controllerAddr = "[Customer address — please update in Workspace Settings]"
	}
	now := time.Now().UTC().Format("2006-01-02")
	return fmt.Sprintf(`# Data Processing Agreement (DPA)

**Version:** %s
**Effective Date:** %s
**Document SHA-256:** (see X-Body-SHA256 response header)

## Parties

**Controller (Customer):** %s, %s.
**Processor (Moosewave):** %s, %s.%s

## 1. Scope and roles

This DPA forms part of the Moosewave Terms of Service between the
Controller and the Processor. The Processor processes Personal Data
on behalf of the Controller solely for the purpose of providing the
Moosewave email delivery, marketing automation, and deliverability
services ("Services") as described in the Agreement.

## 2. Definitions

Capitalised terms have the meanings given in Regulation (EU) 2016/679
("GDPR"), the UK GDPR, and the California Consumer Privacy Act
("CCPA"), unless otherwise defined herein.

## 3. Processing of Personal Data

3.1. The Processor will Process Personal Data only on documented
instructions from the Controller, including transfers to a third
country, unless required by Union or Member State law.

3.2. The categories of Data Subjects, categories of Personal Data,
and processing operations are set out in Appendix A.

## 4. Sub-processors

4.1. The Controller authorises the Processor to engage the
sub-processors listed at https://moosewave.com/legal/sub-processors.

4.2. The Processor will notify the Controller of any intended changes
concerning the addition or replacement of sub-processors, giving the
Controller the opportunity to object within thirty (30) days.

## 5. Security

5.1. The Processor will implement appropriate technical and
organisational measures to ensure a level of security appropriate to
the risk, including those specified in Appendix B.

5.2. The Processor will ensure that persons authorised to Process the
Personal Data have committed themselves to confidentiality.

## 6. Personal Data Breach

6.1. The Processor will notify the Controller without undue delay,
and in any case within 72 hours, after becoming aware of a Personal
Data Breach affecting Controller's Personal Data.

6.2. The notification will include the information required by
Article 33(3) GDPR to the extent then known.

## 7. International Transfers

7.1. Where the Processor transfers Personal Data outside the
European Economic Area, the Processor will rely on the EU Standard
Contractual Clauses (Commission Implementing Decision (EU) 2021/914)
incorporated herein by reference.

## 8. Data Subject Rights

8.1. The Processor will assist the Controller, by appropriate
technical and organisational measures, in fulfilling its obligation
to respond to requests for exercising the Data Subject's rights laid
down in Chapter III of the GDPR.

8.2. The Processor will make available to the Controller the tools
necessary for Data Subject Access Requests, including the
POST /api/v1/privacy/export and POST /api/v1/privacy/deletion
endpoints documented at https://docs.moosewave.com/api-reference.

## 9. Audits

9.1. The Processor will make available to the Controller all
information necessary to demonstrate compliance with Article 28
GDPR. The Processor's most recent SOC 2 Type II report is available
under NDA upon written request.

## 10. Return or Deletion of Personal Data

10.1. Upon termination of the Services, the Processor will, at the
choice of the Controller, delete or return all Personal Data, and
delete existing copies unless Union or Member State law requires
storage.

## 11. Liability

This DPA does not alter the limitations of liability set out in the
Agreement.

## 12. Governing Law

This DPA is governed by the law specified in the Agreement, subject
to mandatory data-protection law of the Controller's jurisdiction.

---

## Appendix A — Subject matter, duration, nature and purpose

**Subject matter:** Provision of email delivery and marketing
automation services.

**Duration:** For the term of the Agreement.

**Nature and purpose:** Processing of subscriber records, message
events (sends, opens, clicks, bounces, complaints), and metadata
necessary to deliver email on behalf of the Controller.

**Categories of Data Subjects:**
- The Controller's customers, prospects, and subscribers.
- The Controller's employees with access to the Moosewave application.

**Categories of Personal Data:**
- Identifiers: name, email address, phone number, postal address.
- Engagement metadata: opens, clicks, bounces, unsubscribes.
- Technical identifiers: IP address, user agent, device type.

## Appendix B — Technical and Organisational Measures

1. **Access control.** Role-based access; admin/owner/editor/viewer
   tiers enforced server-side. Optional SSO/SCIM provisioning.
2. **Encryption at rest.** AES-256-GCM via envelope cipher; optional
   BYOK (per-tenant KMS) for SOC2/HIPAA tiers.
3. **Encryption in transit.** TLS 1.2+ for all customer traffic;
   TLS 1.3 preferred.
4. **Audit logging.** Every Personal-Data-affecting action is
   recorded in audit_log with actor, IP, user-agent; tamper-
   evident chain via SHA-256 hash chain + periodic signed roots.
   Configurable streaming to customer S3/Datadog/Splunk.
5. **Suppression.** Per-tenant suppression list with idempotent
   bounce/complaint ingest; manual unsubscribe enforcement on every
   send.
6. **Backups.** Daily encrypted backups retained 35 days; quarterly
   restore drills.
7. **Personnel.** Background checks on engineering hires; written
   confidentiality undertakings; least-privilege production access
   via short-lived JIT credentials.

---

*This DPA is generated by Moosewave for %s on %s. The
SHA-256 of the rendered text serves as evidence of the exact bundle
the Controller downloaded; the document is countersigned by Moosewave
upon execution.*
`,
		d.versionOrDefault(),
		now,
		controllerName,
		controllerAddr,
		d.processorNameOrDefault(),
		processorAddr,
		euRepr,
		controllerName,
		now,
	)
}
