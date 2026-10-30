package commerce

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const defaultStateTolerance = 30 * time.Minute
const defaultStripeWebhookTolerance = 5 * time.Minute

var (
	ErrMissingSecret    = errors.New("commerce: missing hmac secret")
	ErrMissingSignature = errors.New("commerce: missing hmac signature")
	ErrInvalidSignature = errors.New("commerce: invalid hmac signature")
	ErrExpiredState     = errors.New("commerce: oauth state expired")
)

func VerifyShopifyWebhookHMAC(secret string, body []byte, header string) error {
	return verifyBase64HMACSHA256(secret, body, header)
}

func VerifyWooCommerceWebhookSignature(secret string, body []byte, header string) error {
	return verifyBase64HMACSHA256(secret, body, header)
}

func VerifyStripeWebhookSignature(secret, header string, body []byte, now time.Time, tolerance time.Duration) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingSecret
	}
	if header == "" {
		return ErrMissingSignature
	}
	if tolerance <= 0 {
		tolerance = defaultStripeWebhookTolerance
	}
	var timestamp string
	signatures := []string{}
	for _, part := range strings.Split(header, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch key {
		case "t":
			timestamp = strings.TrimSpace(value)
		case "v1":
			signatures = append(signatures, strings.TrimSpace(value))
		}
	}
	if timestamp == "" || len(signatures) == 0 {
		return ErrMissingSignature
	}
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("commerce: bad stripe webhook timestamp: %w", err)
	}
	sentAt := time.Unix(ts, 0)
	if drift := now.Sub(sentAt); drift > tolerance || drift < -tolerance {
		return ErrExpiredState
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	for _, signature := range signatures {
		if hmac.Equal([]byte(expected), []byte(signature)) {
			return nil
		}
	}
	return ErrInvalidSignature
}

func VerifySquareWebhookSignature(signatureKey, notificationURL string, body []byte, header string) error {
	signatureKey = strings.TrimSpace(signatureKey)
	notificationURL = strings.TrimSpace(notificationURL)
	header = strings.TrimSpace(header)
	if signatureKey == "" {
		return ErrMissingSecret
	}
	if notificationURL == "" {
		return errors.New("commerce: missing square notification url")
	}
	if header == "" {
		return ErrMissingSignature
	}
	mac := hmac.New(sha256.New, []byte(signatureKey))
	mac.Write([]byte(notificationURL))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(header)) {
		return ErrInvalidSignature
	}
	return nil
}

func VerifySquarespaceWebhookSignature(secretHex string, body []byte, header string) error {
	secretHex = strings.TrimSpace(secretHex)
	header = strings.TrimSpace(header)
	if secretHex == "" {
		return ErrMissingSecret
	}
	if header == "" {
		return ErrMissingSignature
	}
	secret, err := hex.DecodeString(secretHex)
	if err != nil {
		return fmt.Errorf("commerce: bad squarespace webhook secret: %w", err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(strings.ToLower(header))) {
		return ErrInvalidSignature
	}
	return nil
}

func VerifyRazorpayWebhookSignature(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingSecret
	}
	if header == "" {
		return ErrMissingSignature
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(strings.ToLower(header))) {
		return ErrInvalidSignature
	}
	return nil
}

func verifyBase64HMACSHA256(secret string, body []byte, header string) error {
	secret = strings.TrimSpace(secret)
	header = strings.TrimSpace(header)
	if secret == "" {
		return ErrMissingSecret
	}
	if header == "" {
		return ErrMissingSignature
	}
	expectedMAC := hmac.New(sha256.New, []byte(secret))
	expectedMAC.Write(body)
	expected := base64.StdEncoding.EncodeToString(expectedMAC.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(header)) {
		return ErrInvalidSignature
	}
	return nil
}

func VerifyShopifyOAuthHMAC(secret string, values url.Values) error {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return ErrMissingSecret
	}
	got := strings.TrimSpace(values.Get("hmac"))
	if got == "" {
		return ErrMissingSignature
	}
	msg := shopifyOAuthMessage(values)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(strings.ToLower(got))) {
		return ErrInvalidSignature
	}
	return nil
}

func shopifyOAuthMessage(values url.Values) string {
	keys := make([]string, 0, len(values))
	for k := range values {
		if k == "hmac" || k == "signature" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		vals := append([]string(nil), values[k]...)
		sort.Strings(vals)
		parts = append(parts, k+"="+strings.Join(vals, ","))
	}
	return strings.Join(parts, "&")
}

type oauthState struct {
	TenantID string `json:"tenant_id"`
	Shop     string `json:"shop"`
	Nonce    string `json:"nonce"`
	TS       int64  `json:"ts"`
	Sig      string `json:"sig"`
}

// BuildOAuthState returns a base64-encoded, HMAC-signed state token. It
// fails closed when secret is empty: there is no fallback. Operators must
// configure SHOPIFY_STATE_SECRET before any OAuth flow will round-trip.
func BuildOAuthState(secret, tenantID, shop, nonce string, now time.Time) (string, error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return "", ErrMissingSecret
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(shop) == "" || strings.TrimSpace(nonce) == "" {
		return "", fmt.Errorf("commerce: tenant, shop, and nonce are required")
	}
	state := oauthState{
		TenantID: strings.TrimSpace(tenantID),
		Shop:     NormalizeShopDomain(shop),
		Nonce:    strings.TrimSpace(nonce),
		TS:       now.UTC().Unix(),
	}
	state.Sig = signOAuthState(secret, state)
	raw, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// ParseOAuthState verifies + decodes a state previously built by
// BuildOAuthState. It fails closed when secret is empty.
func ParseOAuthState(secret, encoded string, now time.Time, tolerance time.Duration) (tenantID, shop string, err error) {
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return "", "", ErrMissingSecret
	}
	if tolerance <= 0 {
		tolerance = defaultStateTolerance
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", "", fmt.Errorf("commerce: bad oauth state: %w", err)
	}
	var state oauthState
	if err := json.Unmarshal(raw, &state); err != nil {
		return "", "", fmt.Errorf("commerce: bad oauth state json: %w", err)
	}
	if state.Sig == "" || !hmac.Equal([]byte(signOAuthState(secret, state)), []byte(state.Sig)) {
		return "", "", ErrInvalidSignature
	}
	created := time.Unix(state.TS, 0)
	if now.Sub(created) > tolerance || created.Sub(now) > tolerance {
		return "", "", ErrExpiredState
	}
	return state.TenantID, NormalizeShopDomain(state.Shop), nil
}

func signOAuthState(secret string, state oauthState) string {
	msg := strings.Join([]string{
		state.TenantID,
		NormalizeShopDomain(state.Shop),
		state.Nonce,
		strconv.FormatInt(state.TS, 10),
	}, "\n")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(msg))
	return hex.EncodeToString(mac.Sum(nil))
}
