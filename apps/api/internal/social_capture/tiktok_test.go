// SPDX-License-Identifier: AGPL-3.0-only

package social_capture

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

func signTikTok(secret string, ts time.Time, body string) string {
	t := strconv.FormatInt(ts.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "." + body))
	return "t=" + t + ",s=" + hex.EncodeToString(mac.Sum(nil))
}

func TestParseTikTokEvent(t *testing.T) {
	body := []byte(`{"event":"comment","create_time":1700000000,"user_openid":"u-123","content":{"text":"send me the guide","comment_id":"c-9"}}`)
	in, err := ParseTikTokEvent(body)
	if err != nil {
		t.Fatal(err)
	}
	if in.Network != "tiktok" || in.ExternalUserID != "u-123" || in.ExternalThreadID != "c-9" {
		t.Fatalf("bad mapping: %+v", in)
	}
	if in.Answers["message"] != "send me the guide" {
		t.Fatalf("message not mapped: %v", in.Answers)
	}
	// Missing user_openid is rejected.
	if _, err := ParseTikTokEvent([]byte(`{"event":"comment"}`)); err == nil {
		t.Fatal("expected error on missing user_openid")
	}
}

func TestVerifyTikTokSignature(t *testing.T) {
	secret := "app-secret"
	now := time.Unix(1700000000, 0)
	body := []byte(`{"event":"comment","user_openid":"u"}`)
	good := signTikTok(secret, now, string(body))

	if err := VerifyTikTokSignature(good, body, secret, now); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	// Wrong secret.
	if err := VerifyTikTokSignature(good, body, "other", now); err == nil {
		t.Fatal("wrong secret should fail")
	}
	// Tampered body.
	if err := VerifyTikTokSignature(good, []byte(`{"event":"x"}`), secret, now); err == nil {
		t.Fatal("tampered body should fail")
	}
	// Stale timestamp (10 min skew).
	if err := VerifyTikTokSignature(good, body, secret, now.Add(10*time.Minute)); err == nil {
		t.Fatal("stale timestamp should fail")
	}
	// Empty secret = not configured.
	if err := VerifyTikTokSignature(good, body, "", now); err == nil {
		t.Fatal("empty secret should fail")
	}
	// Malformed header.
	if err := VerifyTikTokSignature("garbage", body, secret, now); err == nil {
		t.Fatal("malformed header should fail")
	}
}
