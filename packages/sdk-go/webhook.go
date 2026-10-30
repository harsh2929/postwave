package postwave

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// VerifyWebhook authenticates the canonical timestamped
// X-Postwave-Signature header with a five-minute replay window.
func VerifyWebhook(header, secret string, body []byte) bool {
	return VerifyWebhookAt(header, secret, body, time.Now(), 5*time.Minute)
}

// VerifyWebhookAt is the deterministic verifier for tests/custom tolerances.
// It accepts any matching v1 value during a signing-key rotation.
func VerifyWebhookAt(
	header, secret string,
	body []byte,
	now time.Time,
	tolerance time.Duration,
) bool {
	if header == "" || secret == "" {
		return false
	}
	var timestamp string
	seenTimestamp := false
	signatures := make([]string, 0, 2)
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			if seenTimestamp {
				return false
			}
			seenTimestamp = true
			timestamp = value
		case "v1":
			signatures = append(signatures, value)
		}
	}
	unix, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || unix <= 0 || tolerance < 0 || len(signatures) == 0 {
		return false
	}
	if tolerance > 0 {
		skew := now.Sub(time.Unix(unix, 0))
		if skew < 0 {
			skew = -skew
		}
		if skew > tolerance {
			return false
		}
	}
	expected := computeWebhookSignatureBytes(secret, timestamp, body)
	for _, candidate := range signatures {
		supplied, err := hex.DecodeString(candidate)
		if err == nil && hmac.Equal(supplied, expected) {
			return true
		}
	}
	return false
}

// ComputeWebhookSignature returns the lowercase v1 HMAC digest for an
// explicit Unix timestamp. Signed bytes are timestamp + "." + raw body.
func ComputeWebhookSignature(secret string, timestamp int64, body []byte) string {
	return hex.EncodeToString(
		computeWebhookSignatureBytes(secret, strconv.FormatInt(timestamp, 10), body),
	)
}

// ComputeWebhookSignatureHeader builds a complete canonical fixture header.
func ComputeWebhookSignatureHeader(secret string, timestamp int64, body []byte) string {
	ts := strconv.FormatInt(timestamp, 10)
	return "t=" + ts + ",v1=" + hex.EncodeToString(computeWebhookSignatureBytes(secret, ts, body))
}

func computeWebhookSignatureBytes(secret, timestamp string, body []byte) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp))
	_, _ = mac.Write([]byte("."))
	_, _ = mac.Write(body)
	return mac.Sum(nil)
}
