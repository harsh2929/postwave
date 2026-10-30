package runtime

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// WebhookRequest is the outbound HTTP call a webhook node / flow_webhook action
// makes. Method defaults to POST; Payload is marshalled to a JSON body.
type WebhookRequest struct {
	URL          string
	Method       string
	Payload      map[string]interface{}
	AutomationID string
	NodeID       string
}

// WebhookEmitter performs an automation's outbound HTTP call. nil disables
// webhook nodes/actions (they advance as a no-op) — the dev/test default.
type WebhookEmitter interface {
	Send(ctx context.Context, req WebhookRequest) error
}

// HTTPWebhookEmitter is the production WebhookEmitter: an SSRF-guarded HTTP
// client that refuses to dial private/loopback/link-local addresses (checked at
// connect time, so DNS-rebinding can't slip a public name resolving to an
// internal IP past us), and optionally HMAC-signs the body.
type HTTPWebhookEmitter struct {
	Client *http.Client
	// SigningSecret, when set, adds an X-Postwave-Signature: sha256=<hex>
	// header over the raw body so receivers can verify authenticity.
	SigningSecret string
}

// NewHTTPWebhookEmitter builds an emitter whose transport blocks connections to
// non-public IPs and caps the request at a sane timeout.
func NewHTTPWebhookEmitter(signingSecret string) *HTTPWebhookEmitter {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if !isPublicIP(ip.IP) {
					return nil, fmt.Errorf("webhook: refusing to dial non-public address %s", ip.IP)
				}
			}
			return dialer.DialContext(ctx, network, addr)
		},
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		MaxIdleConns:          10,
	}
	return &HTTPWebhookEmitter{
		Client:        &http.Client{Timeout: 15 * time.Second, Transport: transport},
		SigningSecret: signingSecret,
	}
}

// isPublicIP reports whether ip is a globally-routable unicast address — i.e.
// NOT loopback, link-local, private (RFC 1918 / ULA), unspecified, multicast,
// or carrier-grade NAT (100.64/10).
func isPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
		ip.IsPrivate() {
		return false
	}
	// Carrier-grade NAT shared range 100.64.0.0/10 (RFC 6598).
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return false
	}
	return true
}

func (e *HTTPWebhookEmitter) Send(ctx context.Context, req WebhookRequest) error {
	url := strings.TrimSpace(req.URL)
	if url == "" {
		return errors.New("webhook: empty url")
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("webhook: url scheme must be http(s): %q", url)
	}
	method := strings.ToUpper(strings.TrimSpace(req.Method))
	switch method {
	case "":
		method = http.MethodPost
	case http.MethodPost, http.MethodPut, http.MethodPatch:
	default:
		return fmt.Errorf("webhook: unsupported method %q", req.Method)
	}

	body, err := json.Marshal(req.Payload)
	if err != nil {
		return fmt.Errorf("webhook: marshal payload: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("webhook: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", "Moosewave-Automation/1.0")
	if req.AutomationID != "" {
		httpReq.Header.Set("X-Postwave-Automation-Id", req.AutomationID)
	}
	if req.NodeID != "" {
		httpReq.Header.Set("X-Postwave-Node-Id", req.NodeID)
	}
	if e.SigningSecret != "" {
		mac := hmac.New(sha256.New, []byte(e.SigningSecret))
		mac.Write(body)
		httpReq.Header.Set("X-Postwave-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}

	resp, err := e.Client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("webhook: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("webhook: %s returned status %d", url, resp.StatusCode)
	}
	return nil
}
