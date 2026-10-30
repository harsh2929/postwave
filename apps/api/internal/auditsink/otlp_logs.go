// SPDX-License-Identifier: AGPL-3.0-only
//
// otlp_logs.go — OpenTelemetry OTLP Logs sink delivery.
//
// Each audit row is mapped to an OTLP LogRecord whose attributes follow
// the OCSF semantic conventions (class_uid, activity_id, etc.) so SOC
// teams can correlate against other OTel-emitted signals in their
// collector pipeline. Transport is OTLP/HTTP with JSON protobuf encoding
// (per spec §1.2): a single POST to
//
//   <endpoint>/v1/logs
//   Content-Type: application/json
//
// The JSON wire shape matches opentelemetry.proto.collector.logs.v1
// (snake_case keys, base64'd traceId/spanId). Choosing HTTP/JSON lets us
// reuse the SSRF-safe http.Client and avoid pulling the (large) gRPC
// dependency tree into apps/api. Operators who want gRPC (port 4317)
// instead of HTTP (port 4318) point an OTel Collector at this sink and
// have it re-emit over gRPC — the collector is the right place for that
// translation.
//
// Compression: when config.compression = "gzip" the body is gzipped and
// the Content-Encoding: gzip header is set. zstd would require an extra
// dep so it's currently rejected by validation.

package auditsink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// otlpLogRecord mirrors opentelemetry.proto.logs.v1.LogRecord in its
// JSON form. Fields not used by the audit-row mapping are omitted.
type otlpLogRecord struct {
	TimeUnixNano         string         `json:"timeUnixNano"`
	ObservedTimeUnixNano string         `json:"observedTimeUnixNano"`
	SeverityNumber       int            `json:"severityNumber"`
	SeverityText         string         `json:"severityText"`
	Body                 otlpAnyValue   `json:"body"`
	Attributes           []otlpKeyValue `json:"attributes"`
}

// otlpAnyValue is the AnyValue oneof flattened to JSON — we only ever
// emit string bodies, so stringValue is sufficient.
type otlpAnyValue struct {
	StringValue string `json:"stringValue,omitempty"`
}

// otlpKeyValue mirrors opentelemetry.proto.common.v1.KeyValue.
type otlpKeyValue struct {
	Key   string       `json:"key"`
	Value otlpAnyValue `json:"value"`
}

// otlpResource carries the resource attributes for the whole batch
// (tenant_id, service.name) — these match OTel semantic conventions.
type otlpResource struct {
	Attributes []otlpKeyValue `json:"attributes"`
}

type otlpScope struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
}

type otlpScopeLogs struct {
	Scope      otlpScope       `json:"scope"`
	LogRecords []otlpLogRecord `json:"logRecords"`
}

type otlpResourceLogs struct {
	Resource  otlpResource    `json:"resource"`
	ScopeLogs []otlpScopeLogs `json:"scopeLogs"`
}

type otlpLogsRequest struct {
	ResourceLogs []otlpResourceLogs `json:"resourceLogs"`
}

// mapAuditRowToOTLPLogRecord projects one audit row onto one
// LogRecord. Attribute keys follow OCSF + OTel conventions where they
// overlap (e.g. user.id, user.name, http.client_ip).
func mapAuditRowToOTLPLogRecord(r AuditRow) otlpLogRecord {
	t := r.At
	if t.IsZero() {
		t = time.Now().UTC()
	}
	ts := fmt.Sprintf("%d", t.UnixNano())
	attrs := []otlpKeyValue{
		{Key: "postwave.audit.id", Value: otlpAnyValue{StringValue: fmt.Sprintf("%d", r.ID)}},
		{Key: "postwave.tenant_id", Value: otlpAnyValue{StringValue: r.TenantID}},
		{Key: "postwave.audit.action", Value: otlpAnyValue{StringValue: r.Action}},
	}
	if r.UserID != "" {
		attrs = append(attrs, otlpKeyValue{Key: "user.id", Value: otlpAnyValue{StringValue: r.UserID}})
	}
	if r.ActorLabel != "" {
		attrs = append(attrs, otlpKeyValue{Key: "user.name", Value: otlpAnyValue{StringValue: r.ActorLabel}})
	}
	if r.ActorType != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.actor.type", Value: otlpAnyValue{StringValue: r.ActorType}})
	}
	if r.ResourceType != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.resource.type", Value: otlpAnyValue{StringValue: r.ResourceType}})
	}
	if r.ResourceID != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.resource.id", Value: otlpAnyValue{StringValue: r.ResourceID}})
	}
	if r.IP != "" {
		attrs = append(attrs, otlpKeyValue{Key: "client.address", Value: otlpAnyValue{StringValue: r.IP}})
	}
	if r.UserAgent != "" {
		attrs = append(attrs, otlpKeyValue{Key: "user_agent.original", Value: otlpAnyValue{StringValue: r.UserAgent}})
	}
	if r.RowHash != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.audit.row_hash", Value: otlpAnyValue{StringValue: r.RowHash}})
	}
	if r.PrevHash != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.audit.prev_hash", Value: otlpAnyValue{StringValue: r.PrevHash}})
	}
	if r.EventID != "" {
		attrs = append(attrs, otlpKeyValue{Key: "postwave.audit.event_id", Value: otlpAnyValue{StringValue: r.EventID}})
	}
	if len(r.Metadata) > 0 {
		// Encode the metadata blob as a single JSON-stringified attribute
		// — collectors that want structured attributes parse it back.
		if blob, err := json.Marshal(r.Metadata); err == nil {
			attrs = append(attrs, otlpKeyValue{Key: "postwave.audit.metadata", Value: otlpAnyValue{StringValue: string(blob)}})
		}
	}
	// OCSF severity mapping is action-dependent but at the row level we
	// don't classify; INFO (9) is the OTel default for audit-style
	// events per spec §1.4. Authentication failures bubble through OCSF
	// elsewhere; here we keep the LogRecord simple.
	body := fmt.Sprintf("%s by %s", r.Action, r.ActorLabel)
	if r.ActorLabel == "" {
		body = r.Action
	}
	return otlpLogRecord{
		TimeUnixNano:         ts,
		ObservedTimeUnixNano: ts,
		SeverityNumber:       9, // INFO
		SeverityText:         "INFO",
		Body:                 otlpAnyValue{StringValue: body},
		Attributes:           attrs,
	}
}

// deliverOTLPLogs ships rows as an OTLP/HTTP+JSON ExportLogsServiceRequest.
//
// Config:
//
//	endpoint     — required, e.g. https://otel-collector.example.com:4318
//	headers      — optional, "Key: Value\nKey2: Value2" string (one per
//	               line) for tenant auth tokens, X-Org-ID, etc.
//	compression  — optional, "" | "gzip" (default: none)
//	service_name — optional, defaults to "postwave-audit"
func (d *Deps) deliverOTLPLogs(ctx context.Context, s Sink, rows []AuditRow, creds map[string]string) error {
	endpoint, _ := s.Config["endpoint"].(string)
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if endpoint == "" {
		return errors.New("otlp_logs: config.endpoint required")
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		return errors.New("otlp_logs: endpoint must be http:// or https://")
	}
	// Allow operators to point at the OTLP root and we add /v1/logs.
	url := endpoint
	if !strings.HasSuffix(url, "/v1/logs") {
		url += "/v1/logs"
	}
	compression, _ := s.Config["compression"].(string)
	compression = strings.ToLower(strings.TrimSpace(compression))
	if compression != "" && compression != "gzip" && compression != "none" {
		return fmt.Errorf("otlp_logs: unsupported compression %q (allowed: gzip, none)", compression)
	}
	serviceName, _ := s.Config["service_name"].(string)
	if strings.TrimSpace(serviceName) == "" {
		serviceName = "postwave-audit"
	}

	records := make([]otlpLogRecord, 0, len(rows))
	for _, r := range rows {
		records = append(records, mapAuditRowToOTLPLogRecord(r))
	}
	req := otlpLogsRequest{
		ResourceLogs: []otlpResourceLogs{{
			Resource: otlpResource{Attributes: []otlpKeyValue{
				{Key: "service.name", Value: otlpAnyValue{StringValue: serviceName}},
				{Key: "postwave.tenant_id", Value: otlpAnyValue{StringValue: s.TenantID}},
				{Key: "postwave.sink.name", Value: otlpAnyValue{StringValue: s.Name}},
				{Key: "postwave.audit.format", Value: otlpAnyValue{StringValue: formatLabel(s)}},
			}},
			ScopeLogs: []otlpScopeLogs{{
				Scope:      otlpScope{Name: "postwave.audit", Version: "1.0.0"},
				LogRecords: records,
			}},
		}},
	}
	body, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("otlp_logs: marshal: %w", err)
	}

	headers := map[string]string{"Content-Type": "application/json"}
	// Tenant-supplied headers. Credentials carry secrets (bearer tokens);
	// config.headers carries non-secret hints (X-Tenant-ID, X-Org-Name).
	if tok := creds["bearer_token"]; tok != "" {
		headers["Authorization"] = "Bearer " + tok
	}
	if api := creds["api_key"]; api != "" {
		headers["X-API-Key"] = api
	}
	if extra, ok := s.Config["headers"].(string); ok && extra != "" {
		for _, line := range strings.Split(extra, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				continue
			}
			k := strings.TrimSpace(parts[0])
			v := strings.TrimSpace(parts[1])
			if k != "" && v != "" {
				headers[k] = v
			}
		}
	}

	if compression == "gzip" {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		if _, err := gz.Write(body); err != nil {
			return fmt.Errorf("otlp_logs: gzip write: %w", err)
		}
		if err := gz.Close(); err != nil {
			return fmt.Errorf("otlp_logs: gzip close: %w", err)
		}
		body = buf.Bytes()
		headers["Content-Encoding"] = "gzip"
	}

	return d.postJSON(ctx, url, headers, body)
}

// otlpTraceIDFromHash is a tiny helper used by tests and future
// span-correlation code: derive a 16-byte trace id from a row hash by
// taking its first 16 bytes (hex → bytes). Returns base64 of the bytes
// as the OTLP JSON wire format expects, or "" if the hash is too short.
func otlpTraceIDFromHash(rowHash string) string {
	if len(rowHash) < 32 {
		return ""
	}
	b, err := hex.DecodeString(rowHash[:32])
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(b)
}

// ensure io is used (placeholder in case future streaming variants
// land in this file).
var _ = io.EOF
