package seedlist

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

// VendorAPIConnector adapts a seedlist-as-a-service API to Moosewave's local
// connector contract. The endpoint can be backed by GlockApps, MailReach, or a
// thin internal proxy that normalizes vendor-specific payloads to:
//
//	{ "messages": [{ "folder": "INBOX", "labels": [], "headers": {"X-Postwave-Test-ID": "..."} }] }
//
// Some vendors expose richer campaign-level reports rather than mailbox IMAP
// semantics. Keep that vendor-specific code outside the poller and normalize at
// this boundary.
type VendorAPIConnector struct {
	Endpoint   string
	APIKey     string
	HTTPClient *http.Client
}

// Capabilities is intentionally conservative. The normalized vendor payload
// used here proves selected headers and placement only; it never fabricates a
// raw message or body-part capture from those fields.
func (*VendorAPIConnector) Capabilities() ConnectorCapabilities {
	return ConnectorCapabilities{
		Headers:         CapabilityAvailable,
		RawMIME:         CapabilityUnavailable,
		BodyParts:       CapabilityUnavailable,
		Placement:       CapabilityAvailable,
		ObservedSurface: CapabilityUnavailable,
	}
}

type vendorMessagesResponse struct {
	Messages []categorizers.Message `json:"messages"`
}

const vendorAPIResponseMaxBytes int64 = 1 << 20

// ConnectorKindFromEnv returns the connector kind implied by env. Production
// startup uses this to fail closed instead of silently running the no-op
// connector.
func ConnectorKindFromEnv() string {
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("SEEDLIST_CONNECTOR")))
	switch mode {
	case "vendor", "imap", "nop":
		return mode
	case "":
		// Infer a sensible default from the configured source.
	default:
		return mode
	}
	if strings.TrimSpace(os.Getenv("SEEDLIST_VENDOR_API_URL")) != "" {
		return "vendor"
	}
	if strings.TrimSpace(os.Getenv("SEEDLIST_CONFIG_PATH")) != "" ||
		strings.TrimSpace(os.Getenv("POSTWAVE_SEEDLIST_IMAP_JSON")) != "" {
		return "imap"
	}
	return "nop"
}

// ConnectorFromEnv returns the configured seed-list connector. Vendor APIs
// win when explicitly requested or when SEEDLIST_VENDOR_API_URL is present;
// IMAP is used for real mailbox polling; otherwise local/dev gets Nop.
func ConnectorFromEnv() Connector {
	switch ConnectorKindFromEnv() {
	case "vendor":
		return vendorConnectorFromEnv()
	case "imap":
		return NewIMAPConnectorFromEnv()
	case "nop":
		return NopConnector{}
	default:
		return NopConnector{}
	}
}

func vendorConnectorFromEnv() Connector {
	endpoint := strings.TrimSpace(os.Getenv("SEEDLIST_VENDOR_API_URL"))
	if endpoint == "" {
		return NopConnector{}
	}
	return &VendorAPIConnector{
		Endpoint: endpoint,
		APIKey:   strings.TrimSpace(os.Getenv("SEEDLIST_VENDOR_API_KEY")),
		HTTPClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

func (c *VendorAPIConnector) FetchTaggedMessages(ctx context.Context, in *Inbox, since time.Time) ([]categorizers.Message, error) {
	if c == nil || strings.TrimSpace(c.Endpoint) == "" {
		return nil, nil
	}
	u, err := url.Parse(c.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("seedlist vendor endpoint: %w", err)
	}
	q := u.Query()
	if in != nil {
		q.Set("mailbox_id", in.ID)
		q.Set("mailbox_address", in.Address)
		q.Set("provider", string(in.Provider))
	}
	if !since.IsZero() {
		q.Set("since", since.UTC().Format(time.RFC3339))
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client := c.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, readErr := readResponseBodyLimited(resp.Body, vendorAPIResponseMaxBytes)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if readErr != nil {
			return nil, fmt.Errorf("seedlist vendor returned %s: %w", resp.Status, readErr)
		}
		return nil, fmt.Errorf("seedlist vendor returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	if readErr != nil {
		return nil, fmt.Errorf("seedlist vendor JSON: %w", readErr)
	}

	var wrapped vendorMessagesResponse
	if err := json.Unmarshal(body, &wrapped); err == nil && wrapped.Messages != nil {
		return normalizeVendorMessages(wrapped.Messages), nil
	}
	var direct []categorizers.Message
	if err := json.Unmarshal(body, &direct); err != nil {
		return nil, fmt.Errorf("seedlist vendor JSON: %w", err)
	}
	return normalizeVendorMessages(direct), nil
}

func readResponseBodyLimited(r io.Reader, maxBytes int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response body too large")
	}
	return body, nil
}

func normalizeVendorMessages(in []categorizers.Message) []categorizers.Message {
	out := make([]categorizers.Message, 0, len(in))
	for _, msg := range in {
		if msg.Headers == nil {
			msg.Headers = map[string]string{}
		}
		if strings.TrimSpace(msg.Headers[PostwaveTestHeader]) == "" {
			continue
		}
		// Raw bytes are excluded from the normalized vendor contract. Even if a
		// payload claims a successful status, absence of exact bytes is an
		// explicit unavailable capability, never synthetic success.
		msg.RawMIME = unavailableRawMIME(rawMIMESourceVendor, "raw_mime_capability_unavailable", 0)
		out = append(out, msg)
	}
	return out
}
