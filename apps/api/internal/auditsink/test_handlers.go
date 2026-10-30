// SPDX-License-Identifier: AGPL-3.0-only
//
// test_handlers.go — "Test delivery" endpoints. Two flavours:
//
//   POST /api/v1/audit-sinks/test          — preflight: caller supplies
//     the full create body (kind + config + credentials) and the
//     server synthesises a single canary audit row and ships it
//     using the same `deliver()` path the worker uses. No row is
//     persisted; no metrics are incremented. Lets the operator
//     validate credentials BEFORE saving the sink.
//
//   POST /api/v1/audit-sinks/{id}/test     — probe an existing sink
//     using its stored credentials. Useful after rotation, or to
//     confirm an upstream that was 5xx-ing has recovered. Does NOT
//     reset the breaker / counters — operator calls /circuit/reset
//     separately when they're ready to resume scheduled delivery.
//
// Test deliveries bypass the cursor, batch loader, and DLQ. The
// payload shipped looks identical to a real audit row apart from the
// `action`, which is set to "audit_sink.test" so receivers can filter
// it out if desired.

package auditsink

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/audit"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/observability"
)

// MountTestRoutes registers the test-delivery endpoints. Kept on its
// own mount so deployments can disable the probe surface without
// touching CRUD.
func (a *AdminDeps) MountTestRoutes(r chi.Router) {
	if a == nil || a.Pool == nil {
		return
	}
	// RBAC-meta-audit: test deliveries trigger outbound POSTs to the
	// configured sink, so they require the configure-sinks scope
	// (preflight is just shape-checking but uses the same key
	// material so we keep the gate tight). ScopeAdmin still grants
	// both as a wildcard.
	cfgGate := apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)
	// p4d-recordsurface-wire-others: test deliveries are operator
	// fire-drill probes — wire them so dashboards see how often the
	// "try it" button gets pressed and how long each probe takes.
	r.With(cfgGate).Post("/api/v1/audit-sinks/test", observability.RecordSurfaceFunc("auditsink", "test_preflight", a.TestPreflight))
	r.With(cfgGate).Post("/api/v1/audit-sinks/{id}/test", observability.RecordSurfaceFunc("auditsink", "test_existing", a.TestExisting))
}

// canaryRow builds the single AuditRow that test deliveries ship.
// `action="audit_sink.test"` is the documented filter point.
func canaryRow(tenantID string) AuditRow {
	return AuditRow{
		ID:           0, // not a real audit_log row
		TenantID:     tenantID,
		Action:       "audit_sink.test",
		ResourceType: "audit_sink",
		Metadata: map[string]any{
			"note": "Test delivery from the Moosewave audit-sink admin UI. Safe to ignore.",
		},
		ActorType:  "system",
		ActorLabel: "postwave-test",
		At:         time.Now().UTC(),
	}
}

// TestPreflight POST /api/v1/audit-sinks/test — validate config + creds
// before persisting. Body is the same shape as Create.
func (a *AdminDeps) TestPreflight(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var in createInput
	if err := httpbody.DecodeJSON(w, r, httpbody.DefaultJSONMaxBodyBytes, &in); err != nil {
		httpbody.WriteError(w, err)
		return

	}
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	switch in.Kind {
	case "s3", "datadog", "splunk", "http",
		"snowflake_shareback", "otlp_logs":
	default:
		writeAdminErr(w, http.StatusBadRequest, "invalid_kind",
			"kind must be one of s3|datadog|splunk|http|snowflake_shareback|otlp_logs")
		return
	}
	if in.Config == nil {
		in.Config = map[string]any{}
	}
	// Build an ephemeral Sink. Credentials go in as a JSON blob that the
	// worker treats as already-decrypted by setting Cipher=nil on the
	// synthetic Deps below — we just hand it the raw bytes.
	credJSON, _ := json.Marshal(in.Credentials)
	outFmt := strings.TrimSpace(in.OutputFormat)
	if outFmt == "" {
		outFmt = FormatNative
	}
	if !validOutputFormat(outFmt) {
		writeAdminErr(w, http.StatusBadRequest, "invalid_output_format",
			"output_format must be one of postwave_native|ocsf_1_8")
		return
	}
	sink := Sink{
		ID:                  "preflight",
		TenantID:            t.ID,
		Kind:                in.Kind,
		Name:                strings.TrimSpace(in.Name),
		Enabled:             true,
		Config:              in.Config,
		CredentialsEnvelope: credJSON,
		ConsecutiveFailures: 0,
		OutputFormat:        outFmt,
	}
	worker := newTestWorker(a /*rawCreds=*/, true)
	if err := worker.deliver(r.Context(), sink, []AuditRow{canaryRow(t.ID)}); err != nil {
		writeAdminErr(w, http.StatusBadGateway, "delivery_failed", "audit sink delivery failed")
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.test_preflight", "audit_sink", "", nil,
		map[string]any{
			"kind":          in.Kind,
			"name":          strings.TrimSpace(in.Name),
			"output_format": outFmt,
		}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{
		"delivered": true,
		"kind":      in.Kind,
		"action":    "audit_sink.test",
	})
}

// TestExisting POST /api/v1/audit-sinks/{id}/test — use stored config
// + envelope. Decrypts with the AdminDeps cipher (same one the worker
// uses).
func (a *AdminDeps) TestExisting(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeAdminErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := strings.TrimSpace(chi.URLParam(r, "id"))
	if id == "" {
		writeAdminErr(w, http.StatusBadRequest, "missing_id", "sink id required")
		return
	}
	tx, err := db.WithTenant(r.Context(), a.Pool, t.ID)
	if err != nil {
		writeAdminErr(w, http.StatusInternalServerError, "tx_failed", "an internal error occurred")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	var sink Sink
	var rawConfig []byte
	if err := tx.QueryRow(r.Context(), `
SELECT id::text, tenant_id::text, kind, name, enabled,
       COALESCE(config,'{}'::jsonb),
       COALESCE(credentials_envelope, ''::bytea),
       COALESCE(consecutive_failures,0),
       COALESCE(output_format,'postwave_native')
  FROM audit_sinks
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		t.ID, id).Scan(&sink.ID, &sink.TenantID, &sink.Kind, &sink.Name,
		&sink.Enabled, &rawConfig, &sink.CredentialsEnvelope,
		&sink.ConsecutiveFailures, &sink.OutputFormat); err != nil {
		writeAdminErr(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	_ = json.Unmarshal(rawConfig, &sink.Config)
	_ = tx.Commit(r.Context())

	worker := newTestWorker(a /*rawCreds=*/, false)
	if err := worker.deliver(r.Context(), sink, []AuditRow{canaryRow(t.ID)}); err != nil {
		writeAdminErr(w, http.StatusBadGateway, "delivery_failed", "audit sink delivery failed")
		return
	}
	audit.EmitOrLog(r.Context(), a.Pool, "auditsink.test", "audit_sink", id, nil,
		map[string]any{
			"sink_id": id,
			"kind":    sink.Kind,
		}, nil)
	writeAdminJSON(w, http.StatusOK, map[string]any{
		"delivered": true,
		"kind":      sink.Kind,
		"action":    "audit_sink.test",
	})
}

// newTestWorker builds a one-shot Deps wired for a synchronous probe.
// When rawCreds=true the worker treats the envelope as already-plaintext
// JSON (preflight path). Otherwise it uses the admin cipher.
func newTestWorker(a *AdminDeps, rawCreds bool) *Deps {
	d := &Deps{
		Pool:               a.Pool,
		HTTP:               newAuditSinkHTTPClient(15 * time.Second),
		httpClientHardened: true,
		BatchSize:          1,
		AutoDisableAfter:   100,
	}
	if rawCreds {
		d.Cipher = passthroughCipher{}
	} else {
		d.Cipher = a.Cipher
	}
	return d
}

// passthroughCipher returns the input bytes verbatim. Used only for the
// preflight test path where the operator just typed credentials into a
// form and they haven't been encrypted yet.
type passthroughCipher struct{}

func (passthroughCipher) Decrypt(_ context.Context, blob []byte, _ []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, errors.New("passthroughCipher: empty blob")
	}
	return blob, nil
}
