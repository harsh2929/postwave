// SPDX-License-Identifier: AGPL-3.0-only
//
// tiktok.go — TikTok inbound-event integration for the KLV-02 social-capture
// runtime. TikTok forwards comment / DM events to a configured callback; a
// tenant-authenticated relay POSTs the raw TikTok payload (plus its signature
// header) to this handler, which verifies the signature, maps the event to the
// canonical EventInput, and records a lead against the named rule — the same
// RecordLead path the generic /events endpoint uses, so a TikTok lead flows
// through identical consent + list-handoff logic.
//
// TikTok signs each delivery as `TikTok-Signature: t=<unix>,s=<hexhmac>` where
// the HMAC-SHA256 is over `<t>.<rawbody>` keyed by the app client secret
// (https://developers.tiktok.com/doc/webhooks-overview). The signing logic +
// payload mapping are pure + unit-tested; live delivery needs a registered
// TikTok app (deploy-time credential).

package social_capture

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// tiktokSignatureMaxSkew bounds replay: a delivery whose timestamp is older than
// this (or in the future by more than this) is rejected even if the HMAC
// matches.
const tiktokSignatureMaxSkew = 5 * time.Minute

// tiktokWebhook is the subset of TikTok's webhook envelope we consume. TikTok
// nests the user-authored content under event.content; comments and direct
// messages share this shape.
type tiktokWebhook struct {
	Event      string `json:"event"`
	CreateTime int64  `json:"create_time"`
	UserOpenID string `json:"user_openid"`
	Content    struct {
		Text      string `json:"text"`
		ThreadID  string `json:"thread_id"`
		CommentID string `json:"comment_id"`
	} `json:"content"`
}

// ParseTikTokEvent maps a raw TikTok webhook body to the canonical EventInput.
// network is fixed to "tiktok"; the comment/DM text rides on Answers["message"]
// so the rule's trigger-phrase match (in RecordLead) sees it.
func ParseTikTokEvent(body []byte) (EventInput, error) {
	var w tiktokWebhook
	if err := json.Unmarshal(body, &w); err != nil {
		return EventInput{}, fmt.Errorf("tiktok: decode webhook: %w", err)
	}
	if strings.TrimSpace(w.UserOpenID) == "" {
		return EventInput{}, fmt.Errorf("tiktok: webhook missing user_openid")
	}
	threadID := firstNonEmptyStr(w.Content.ThreadID, w.Content.CommentID)
	return EventInput{
		Network:          "tiktok",
		ExternalUserID:   w.UserOpenID,
		ExternalThreadID: threadID,
		Answers:          map[string]any{"message": w.Content.Text},
		Metadata: map[string]any{
			"tiktok_event": w.Event,
			"create_time":  w.CreateTime,
		},
	}, nil
}

// VerifyTikTokSignature checks the `TikTok-Signature: t=<unix>,s=<hex>` header
// against the body using the app client secret. now is injected for testability.
func VerifyTikTokSignature(header string, body []byte, secret string, now time.Time) error {
	if strings.TrimSpace(secret) == "" {
		return fmt.Errorf("tiktok: signing secret not configured")
	}
	ts, sig := parseTikTokSigHeader(header)
	if ts == "" || sig == "" {
		return fmt.Errorf("tiktok: malformed signature header")
	}
	tsInt, err := time.Parse(time.RFC3339, ts)
	var eventTime time.Time
	if err != nil {
		// TikTok sends a unix-seconds timestamp; fall back to that.
		var secs int64
		if _, e := fmt.Sscanf(ts, "%d", &secs); e != nil {
			return fmt.Errorf("tiktok: bad signature timestamp")
		}
		eventTime = time.Unix(secs, 0)
	} else {
		eventTime = tsInt
	}
	if skew := now.Sub(eventTime); skew > tiktokSignatureMaxSkew || skew < -tiktokSignatureMaxSkew {
		return fmt.Errorf("tiktok: signature timestamp outside allowed skew")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "." + string(body)))
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.ToLower(sig))) {
		return fmt.Errorf("tiktok: signature mismatch")
	}
	return nil
}

func parseTikTokSigHeader(h string) (ts, sig string) {
	for _, part := range strings.Split(h, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			ts = kv[1]
		case "s":
			sig = kv[1]
		}
	}
	return ts, sig
}

// RecordTikTokEvent POSTs a raw TikTok webhook payload (verified) for a rule.
// Authenticated (tenant from context) + write-scoped, mounted alongside the
// generic /events endpoint. The TikTok signing secret comes from Deps.TikTokSecret.
func (d *Deps) RecordTikTokEvent(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	body, err := httpbody.ReadJSONAtMost(r, 256<<10, httpbody.Options{})
	if err != nil {
		if status := httpbody.StatusCode(err); status != http.StatusBadRequest {
			httpbody.WriteError(w, err)
			return
		}
		httperror.WriteValidation(w, "bad_body", httpbody.PublicMessage(err))
		return
	}
	if err := VerifyTikTokSignature(r.Header.Get("TikTok-Signature"), body, d.TikTokSecret, time.Now()); err != nil {
		writeJSON(w, http.StatusUnauthorized, errEnv("bad_signature", "request authentication failed"))
		return
	}
	in, err := ParseTikTokEvent(body)
	if err != nil {
		httperror.WriteValidation(w, "bad_payload", "request payload is invalid")
		return
	}
	out, err := d.Repo.RecordLead(r.Context(), tenantID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoError(w, r, err, tenantID)
		return
	}
	writeJSON(w, http.StatusAccepted, out)
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
