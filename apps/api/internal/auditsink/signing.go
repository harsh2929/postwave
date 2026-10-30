// SPDX-License-Identifier: AGPL-3.0-only
//
// signing.go — Standard Webhooks (RFC 9499 / standardwebhooks.com)
// signature helpers, plus a stable UUIDv5-style event_id derivation
// used as the `webhook-id` idempotency key.
//
// Two signature shapes live side-by-side:
//
//   - postwave_v1   — legacy. `X-Postwave-Signature: sha256=<hex>` over
//                     the raw body. Kept for backward compat — existing
//                     receivers don't need to change anything.
//   - standard_webhooks — RFC 9499:
//                     webhook-id:        <uuid>
//                     webhook-timestamp: <unix seconds>
//                     webhook-signature: v1,<base64(hmac_sha256(secret,
//                                        webhook_id "." webhook_timestamp "." body))>
//                     The base64 string contains NO `=` padding (the
//                     RFC mandates base64-no-pad).
//
// Both share the same `webhook-id` value when the sink is HTTP — derived
// from the audit_log row via DeriveEventID so retries dedupe end-to-end.

package auditsink

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"
)

// Webhook format strings stored in audit_sinks.webhook_format and read
// by deliverHTTP to pick the signature shape.
const (
	WebhookFormatPostwaveV1      = "postwave_v1"
	WebhookFormatStandardWebhook = "standard_webhooks"
)

// validWebhookFormat is the package-private allow-list for the
// webhook_format column. Mirrored in migration 0264.
func validWebhookFormat(s string) bool {
	switch s {
	case WebhookFormatPostwaveV1, WebhookFormatStandardWebhook:
		return true
	}
	return false
}

// SignatureV1 returns the Standard Webhooks `webhook-signature` header
// value: "v1,<base64-no-pad(hmac_sha256(secret, id "." ts "." body))>".
//
// `secret` is interpreted as the raw HMAC key bytes — callers are
// expected to have already decoded any base64 envelope (the secret
// envelope from audit_sink_signing_keys is decrypted by the worker
// before being passed here).
//
// Compatible with the public `standardwebhooks` SDKs (Node/Python/Go).
func SignatureV1(secret []byte, webhookID string, ts time.Time, body []byte) string {
	tsStr := strconv.FormatInt(ts.Unix(), 10)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(webhookID))
	mac.Write([]byte("."))
	mac.Write([]byte(tsStr))
	mac.Write([]byte("."))
	mac.Write(body)
	sig := base64.StdEncoding.WithPadding(base64.NoPadding).EncodeToString(mac.Sum(nil))
	return "v1," + sig
}

// LegacySignatureV1 returns the historic `X-Postwave-Signature` shape:
// "sha256=<hex(hmac_sha256(secret, body))>". Used by the postwave_v1
// path so the dispatcher stays small.
func LegacySignatureV1(secret []byte, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// auditNamespace is the deterministic UUID namespace used to derive the
// `webhook-id` from an audit_log row. Random-but-fixed per the spec
// recommendation for UUIDv5 (RFC 4122 §4.3) — never change this value
// or existing event_ids stop matching.
//
// Value: sha1("postwave.audit.event_id.v1") truncated to 16 bytes,
// stamped with the UUIDv5 version + variant bits.
var auditNamespace = [16]byte{
	0x6d, 0xf5, 0x69, 0xae, 0xc2, 0x8b, 0x4e, 0x52,
	0x9a, 0x0e, 0x21, 0x3d, 0x4c, 0x77, 0x65, 0xb1,
}

// DeriveEventID computes a stable UUIDv5 over the audit row's identity
// tuple: (tenant_id, action, resource_type, resource_id, actor_label,
// unix_seconds). Used as the Standard Webhooks `webhook-id` header so
// duplicate deliveries (retries, DLQ replays) carry the same idempotency
// key end-to-end.
//
// Determinism is critical: same input tuple MUST produce the same UUID
// across replicas and across replay paths. The DLQ replay worker calls
// this exact function so the receiver's dedup table catches the replay
// even if the original delivery already landed.
func DeriveEventID(tenantID, action, resourceType, resourceID, actorLabel string, at time.Time) string {
	h := sha1.New()
	h.Write(auditNamespace[:])
	h.Write([]byte(tenantID))
	h.Write([]byte{0x00})
	h.Write([]byte(action))
	h.Write([]byte{0x00})
	h.Write([]byte(resourceType))
	h.Write([]byte{0x00})
	h.Write([]byte(resourceID))
	h.Write([]byte{0x00})
	h.Write([]byte(actorLabel))
	h.Write([]byte{0x00})
	h.Write([]byte(strconv.FormatInt(at.Unix(), 10)))
	sum := h.Sum(nil)
	// RFC 4122 §4.3: version 5 in upper nibble of byte 6, variant
	// (10xx) in upper bits of byte 8.
	sum[6] = (sum[6] & 0x0F) | 0x50
	sum[8] = (sum[8] & 0x3F) | 0x80
	return formatUUID(sum[:16])
}

// formatUUID writes the canonical 8-4-4-4-12 hex form.
func formatUUID(b []byte) string {
	if len(b) < 16 {
		return ""
	}
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
