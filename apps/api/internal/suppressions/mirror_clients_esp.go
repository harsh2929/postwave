// mirror_clients_esp.go — GAP-LS-026. Real suppression-pull
// MirrorClient implementations for SES, Mailgun, and Postmark. These
// replace the NewNilMirrorClient placeholders whose FetchRecent always
// returned ErrMirrorClientUnavailable.
//
// The three clients follow the seams established by SendGrid/Mailchimp
// in mirror_clients.go so main.go wires them identically:
//
//   - Mailgun + Postmark are REST clients with the SendGrid shape — a
//     BaseURL override (tests point it at an httptest.Server; production
//     leaves it empty for the real API host), an injected *http.Client,
//     and a MirrorCredentialSource that resolves the API key via the
//     tenant's provider-config credential_ref / vault secret with a
//     POSTWAVE_MIRROR_<PROVIDER>_API_KEY env fallback.
//
//   - SES is the one deviation: its account-level suppression list is
//     authenticated through the standard AWS credential chain (env, IAM
//     role, EC2/ECS metadata) — there is no per-tenant API key — so it
//     takes an AWS region instead of a MirrorCredentialSource, mirroring
//     mailer/ses.go. A narrow sesSuppressionAPI interface (exactly the
//     two methods the mirror calls) keeps it unit-testable without AWS.
//
// Every record's SourceEventID is keyed on a stable provider identity
// (address or event id) so repeated mirror runs dedupe on
// (tenant, source, source_event_id) via the Store.Add path instead of
// re-churning rows.

package suppressions

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sesv2"
	sestypes "github.com/aws/aws-sdk-go-v2/service/sesv2/types"
)

// Compile-time proof the three clients satisfy MirrorClient.
var (
	_ MirrorClient = (*SESMirrorClient)(nil)
	_ MirrorClient = (*MailgunMirrorClient)(nil)
	_ MirrorClient = (*PostmarkMirrorClient)(nil)
)

/* ---------- SES --------------------------------------------------- */

// sesSuppressionAPI is the slice of the SES v2 client surface the
// suppression mirror depends on. Defined as an interface for
// testability — production wires the concrete *sesv2.Client, tests
// inject a mock returning canned destinations. The concrete client
// satisfies this exactly (see the assertion below).
type sesSuppressionAPI interface {
	ListSuppressedDestinations(ctx context.Context, params *sesv2.ListSuppressedDestinationsInput, optFns ...func(*sesv2.Options)) (*sesv2.ListSuppressedDestinationsOutput, error)
	GetSuppressedDestination(ctx context.Context, params *sesv2.GetSuppressedDestinationInput, optFns ...func(*sesv2.Options)) (*sesv2.GetSuppressedDestinationOutput, error)
}

var _ sesSuppressionAPI = (*sesv2.Client)(nil)

// SESMirrorClient pulls the account-level SES suppression list:
//
//	ListSuppressedDestinations (StartDate=since, paginated via NextToken)
//	GetSuppressedDestination   (best-effort enrich: feedback_id, message_id)
//
// SES suppression is account/region-scoped, not per-tenant, so tenantID
// is accepted for interface parity but does not scope the fetch — the
// AWS credential chain and region select the list.
type SESMirrorClient struct {
	API sesSuppressionAPI
}

// NewSESMirrorClient constructs an SES-backed mirror client. region is
// the AWS region whose SES suppression list to read; the SDK resolves
// credentials via the standard chain (env, IAM role, EC2/ECS metadata) —
// never pass keys inline. Mirrors mailer.NewSESMailer.
func NewSESMirrorClient(ctx context.Context, region string) (*SESMirrorClient, error) {
	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(region))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("ses mirror: load aws config: %w", err)
	}
	return &SESMirrorClient{API: sesv2.NewFromConfig(cfg)}, nil
}

// sesReason maps the SES suppression reason to our taxonomy. SES only
// ever emits BOUNCE / COMPLAINT.
func sesReason(r sestypes.SuppressionListReason) Reason {
	switch r {
	case sestypes.SuppressionListReasonComplaint:
		return ReasonSpamComplaint
	case sestypes.SuppressionListReasonBounce:
		return ReasonHardBounce
	default:
		return ReasonHardBounce
	}
}

// FetchRecent implements MirrorClient.
func (c *SESMirrorClient) FetchRecent(ctx context.Context, _ string, since time.Time, limit int) ([]MirrorRecord, error) {
	if c == nil || c.API == nil {
		return nil, fmt.Errorf("%w: ses (client not wired)", ErrMirrorClientUnavailable)
	}
	if limit <= 0 {
		limit = 5000
	}
	pageSize := mirrorPageSize
	if limit < pageSize {
		pageSize = limit
	}

	input := &sesv2.ListSuppressedDestinationsInput{
		PageSize: aws.Int32(int32(pageSize)),
	}
	if !since.IsZero() {
		start := since.UTC()
		input.StartDate = &start
	}

	out := make([]MirrorRecord, 0, 64)
	for {
		page, err := c.API.ListSuppressedDestinations(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("ses list suppressed destinations: %w", err)
		}
		for _, sum := range page.SuppressedDestinationSummaries {
			if len(out) >= limit {
				break
			}
			if sum.EmailAddress == nil {
				continue
			}
			email := strings.TrimSpace(*sum.EmailAddress)
			if email == "" {
				continue
			}
			var updated time.Time
			if sum.LastUpdateTime != nil {
				updated = sum.LastUpdateTime.UTC()
			}
			// SES filters server-side on StartDate, but a mock (or an
			// SDK that widens the window) may return older rows — drop
			// anything genuinely before the requested window.
			if !since.IsZero() && !updated.IsZero() && updated.Before(since) {
				continue
			}
			meta := map[string]any{"ses_reason": string(sum.Reason)}
			c.enrich(ctx, email, meta)
			out = append(out, MirrorRecord{
				Email:  email,
				Reason: sesReason(sum.Reason),
				// One suppression entry per address account-wide, so the
				// lowercased address is the stable dedup key across runs.
				SourceEventID: "ses:" + strings.ToLower(email),
				CreatedAt:     updated,
				Metadata:      meta,
			})
		}
		if len(out) >= limit || page.NextToken == nil || *page.NextToken == "" {
			break
		}
		input.NextToken = page.NextToken
	}
	return out, nil
}

// enrich attaches the feedback/message ids from GetSuppressedDestination
// to the record metadata. Best-effort: a failed or empty lookup leaves
// the summary-derived record intact rather than failing the whole run.
func (c *SESMirrorClient) enrich(ctx context.Context, email string, meta map[string]any) {
	got, err := c.API.GetSuppressedDestination(ctx, &sesv2.GetSuppressedDestinationInput{
		EmailAddress: aws.String(email),
	})
	if err != nil || got == nil || got.SuppressedDestination == nil {
		return
	}
	attrs := got.SuppressedDestination.Attributes
	if attrs == nil {
		return
	}
	if attrs.FeedbackId != nil && *attrs.FeedbackId != "" {
		meta["feedback_id"] = *attrs.FeedbackId
	}
	if attrs.MessageId != nil && *attrs.MessageId != "" {
		meta["message_id"] = *attrs.MessageId
	}
}

/* ---------- Mailgun ----------------------------------------------- */

// mailgunDefaultBaseURL is the US API host. EU accounts run on
// https://api.eu.mailgun.net; set BaseURL to switch regions.
const mailgunDefaultBaseURL = "https://api.mailgun.net"

// mailgunDomainEnvKey is the self-hosted fallback for the sending
// domain when the client's Domain field is empty.
const mailgunDomainEnvKey = "POSTWAVE_MIRROR_MAILGUN_DOMAIN"

// MailgunMirrorClient pulls the three Mailgun per-domain suppression
// lists:
//
//	GET /v3/{domain}/bounces       → hard_bounce
//	GET /v3/{domain}/complaints    → spam_complaint
//	GET /v3/{domain}/unsubscribes  → manual_unsubscribe
//
// All three authenticate with HTTP basic auth (username "api", password
// = API key) and page via an opaque cursor carried in paging.next.
type MailgunMirrorClient struct {
	Credentials MirrorCredentialSource
	// BaseURL overrides https://api.mailgun.net (tests point this at an
	// httptest.Server; EU accounts use https://api.eu.mailgun.net).
	BaseURL string
	// Domain is the Mailgun sending domain whose suppression lists to
	// pull (Mailgun scopes suppressions per domain, unlike SendGrid's
	// account-wide lists). Falls back to POSTWAVE_MIRROR_MAILGUN_DOMAIN.
	Domain string
	HTTP   *http.Client
}

// NewMailgunMirrorClient wires the production client. Set Domain (or
// POSTWAVE_MIRROR_MAILGUN_DOMAIN) before use.
func NewMailgunMirrorClient(creds MirrorCredentialSource) *MailgunMirrorClient {
	return &MailgunMirrorClient{Credentials: creds}
}

// mailgunItem is the row shape shared by all three suppression lists;
// each list simply omits the fields it doesn't populate.
type mailgunItem struct {
	Address   string          `json:"address"`
	Code      string          `json:"code"`   // bounces
	Error     string          `json:"error"`  // bounces
	Reason    string          `json:"reason"` // bounces (sometimes)
	Tags      []string        `json:"tags"`   // unsubscribes
	CreatedAt json.RawMessage `json:"created_at"`
}

type mailgunPage struct {
	Items  []mailgunItem `json:"items"`
	Paging struct {
		Next     string `json:"next"`
		Previous string `json:"previous"`
		First    string `json:"first"`
		Last     string `json:"last"`
	} `json:"paging"`
}

// FetchRecent implements MirrorClient.
func (c *MailgunMirrorClient) FetchRecent(ctx context.Context, tenantID string, since time.Time, limit int) ([]MirrorRecord, error) {
	if c == nil || c.Credentials == nil {
		return nil, fmt.Errorf("%w: mailgun (client not wired)", ErrMirrorNotConfigured)
	}
	key, err := c.Credentials.APIKey(ctx, tenantID, MirrorProviderMailgun)
	if err != nil {
		return nil, err
	}
	domain := strings.TrimSpace(c.Domain)
	if domain == "" {
		domain = strings.TrimSpace(os.Getenv(mailgunDomainEnvKey))
	}
	if domain == "" {
		return nil, fmt.Errorf("%w: mailgun (no sending domain; set client Domain or %s)",
			ErrMirrorNotConfigured, mailgunDomainEnvKey)
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = mailgunDefaultBaseURL
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: mirrorHTTPTimeout}
	}
	if limit <= 0 {
		limit = 5000
	}

	lists := []struct {
		kind   string // "bounces" | "complaints" | "unsubscribes"
		reason Reason
	}{
		{"bounces", ReasonHardBounce},
		{"complaints", ReasonSpamComplaint},
		{"unsubscribes", ReasonManualUnsubscribe},
	}

	out := make([]MirrorRecord, 0, 64)
	for _, list := range lists {
		path := "/v3/" + domain + "/" + list.kind
		q := url.Values{}
		q.Set("limit", strconv.Itoa(mirrorPageSize))
		query := q.Encode()
		seen := map[string]bool{}
		for len(out) < limit {
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path+"?"+query, nil)
			if err != nil {
				return nil, err
			}
			req.SetBasicAuth("api", key)
			req.Header.Set("Accept", "application/json")

			var page mailgunPage
			if err := mirrorGetJSON(ctx, hc, req, &page); err != nil {
				return nil, fmt.Errorf("mailgun %s: %w", list.kind, err)
			}
			for _, item := range page.Items {
				if len(out) >= limit {
					break
				}
				email := strings.TrimSpace(item.Address)
				if email == "" {
					continue
				}
				created := mailgunTimeFromRaw(item.CreatedAt)
				// Mailgun has no server-side since filter on these lists;
				// drop rows older than the window client-side, but keep
				// rows whose timestamp we couldn't parse (better to
				// re-suppress than silently lose a bounce).
				if !since.IsZero() && !created.IsZero() && created.Before(since) {
					continue
				}
				meta := map[string]any{"mailgun_list": list.kind}
				if item.Code != "" {
					meta["provider_code"] = item.Code
				}
				if item.Error != "" {
					meta["provider_error"] = item.Error
				}
				if item.Reason != "" {
					meta["provider_reason"] = item.Reason
				}
				if len(item.Tags) > 0 {
					meta["tags"] = item.Tags
				}
				out = append(out, MirrorRecord{
					Email:         email,
					Reason:        list.reason,
					SourceEventID: "mailgun:" + list.kind + ":" + strings.ToLower(email),
					CreatedAt:     created,
					Metadata:      meta,
				})
			}
			// Cursor paging: follow paging.next's query against our own
			// base+path (never the provider's absolute URL). Stop on an
			// empty page, an absent/looping cursor, or a short page.
			if len(page.Items) == 0 || len(page.Items) < mirrorPageSize {
				break
			}
			next := mailgunNextQuery(page.Paging.Next)
			if next == "" || next == query || seen[next] {
				break
			}
			seen[query] = true
			query = next
		}
	}
	return out, nil
}

// mailgunNextQuery extracts just the raw query string from a Mailgun
// paging.next URL so the cursor is re-applied against our configured
// BaseURL rather than following the provider-supplied absolute host.
func mailgunNextQuery(next string) string {
	next = strings.TrimSpace(next)
	if next == "" {
		return ""
	}
	u, err := url.Parse(next)
	if err != nil {
		return ""
	}
	return u.RawQuery
}

// mailgunTimeFromRaw parses a Mailgun created_at, which is normally an
// RFC 2822 string ("Fri, 21 Oct 2011 11:02:55 UTC") but has been seen
// as a bare unix-seconds number across API versions. Unparseable →
// zero time (the record still imports; the handler tolerates it).
func mailgunTimeFromRaw(raw json.RawMessage) time.Time {
	s := strings.TrimSpace(string(raw))
	if s == "" || s == "null" {
		return time.Time{}
	}
	if strings.HasPrefix(s, "\"") {
		var str string
		if err := json.Unmarshal(raw, &str); err != nil {
			return time.Time{}
		}
		return parseMailgunTime(str)
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil && f > 0 {
		return time.Unix(int64(f), 0).UTC()
	}
	return time.Time{}
}

func parseMailgunTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}
	}
	for _, layout := range []string{
		time.RFC1123Z, // "Mon, 02 Jan 2006 15:04:05 -0700"
		time.RFC1123,  // "Mon, 02 Jan 2006 15:04:05 MST"
		time.RFC3339,
		"Mon, 2 Jan 2006 15:04:05 MST",
		"Mon, 2 Jan 2006 15:04:05 -0700",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC()
		}
	}
	return time.Time{}
}

/* ---------- Postmark ---------------------------------------------- */

// postmarkDefaultBaseURL is the Postmark API host.
const postmarkDefaultBaseURL = "https://api.postmarkapp.com"

// PostmarkMirrorClient pulls the account bounce list, which is
// Postmark's suppression surface:
//
//	GET /bounces?count=&offset=&fromdate=  (X-Postmark-Server-Token auth)
//
// Only bounce types that represent a durable suppression are mapped
// (hard bounces, spam complaints, unsubscribes, DNS failures); transient
// types (SoftBounce, Transient, AutoResponder, …) are skipped.
type PostmarkMirrorClient struct {
	Credentials MirrorCredentialSource
	// BaseURL overrides https://api.postmarkapp.com (tests point this at
	// an httptest.Server).
	BaseURL string
	HTTP    *http.Client
}

// NewPostmarkMirrorClient wires the production client.
func NewPostmarkMirrorClient(creds MirrorCredentialSource) *PostmarkMirrorClient {
	return &PostmarkMirrorClient{Credentials: creds}
}

type postmarkBounce struct {
	ID        int64     `json:"ID"`
	Type      string    `json:"Type"`
	Email     string    `json:"Email"`
	BouncedAt time.Time `json:"BouncedAt"`
	Inactive  bool      `json:"Inactive"`
	MessageID string    `json:"MessageID"`
	Tag       string    `json:"Tag"`
}

type postmarkBouncesPage struct {
	TotalCount int              `json:"TotalCount"`
	Bounces    []postmarkBounce `json:"Bounces"`
}

// postmarkReason maps a Postmark bounce Type to our taxonomy. The
// boolean reports whether the type is a durable suppression worth
// importing (false → skip the row).
func postmarkReason(bounceType string) (Reason, bool) {
	switch bounceType {
	case "HardBounce", "BadEmailAddress", "ManuallyDeactivated", "Blocked":
		return ReasonHardBounce, true
	case "SpamComplaint", "SpamNotification", "VirusNotification":
		return ReasonSpamComplaint, true
	case "Unsubscribe":
		return ReasonManualUnsubscribe, true
	case "DnsError":
		return ReasonDNSFail, true
	default:
		return "", false
	}
}

// FetchRecent implements MirrorClient.
func (c *PostmarkMirrorClient) FetchRecent(ctx context.Context, tenantID string, since time.Time, limit int) ([]MirrorRecord, error) {
	if c == nil || c.Credentials == nil {
		return nil, fmt.Errorf("%w: postmark (client not wired)", ErrMirrorNotConfigured)
	}
	key, err := c.Credentials.APIKey(ctx, tenantID, MirrorProviderPostmark)
	if err != nil {
		return nil, err
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = postmarkDefaultBaseURL
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: mirrorHTTPTimeout}
	}
	if limit <= 0 {
		limit = 5000
	}

	out := make([]MirrorRecord, 0, 64)
	for offset := 0; len(out) < limit; offset += mirrorPageSize {
		q := url.Values{}
		q.Set("count", strconv.Itoa(mirrorPageSize))
		q.Set("offset", strconv.Itoa(offset))
		if !since.IsZero() {
			// Postmark filters bounces server-side by date (YYYY-MM-DD).
			q.Set("fromdate", since.UTC().Format("2006-01-02"))
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/bounces?"+q.Encode(), nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-Postmark-Server-Token", key)
		req.Header.Set("Accept", "application/json")

		var page postmarkBouncesPage
		if err := mirrorGetJSON(ctx, hc, req, &page); err != nil {
			return nil, fmt.Errorf("postmark /bounces: %w", err)
		}
		for _, b := range page.Bounces {
			if len(out) >= limit {
				break
			}
			email := strings.TrimSpace(b.Email)
			if email == "" {
				continue
			}
			reason, ok := postmarkReason(b.Type)
			if !ok {
				continue // transient / non-suppressing bounce type
			}
			created := b.BouncedAt.UTC()
			if !since.IsZero() && !created.IsZero() && created.Before(since) {
				continue
			}
			meta := map[string]any{
				"postmark_type": b.Type,
				"inactive":      b.Inactive,
			}
			if b.MessageID != "" {
				meta["message_id"] = b.MessageID
			}
			if b.Tag != "" {
				meta["tag"] = b.Tag
			}
			// Postmark bounce ids are stable and immutable → the ideal
			// dedup key; fall back to an address key if one is absent.
			sourceEventID := "postmark:bounce:" + strconv.FormatInt(b.ID, 10)
			if b.ID == 0 {
				sourceEventID = "postmark:" + strings.ToLower(b.Type) + ":" + strings.ToLower(email)
			}
			out = append(out, MirrorRecord{
				Email:         email,
				Reason:        reason,
				SourceEventID: sourceEventID,
				CreatedAt:     created,
				Metadata:      meta,
			})
		}
		if len(page.Bounces) < mirrorPageSize {
			break // last page
		}
		if page.TotalCount > 0 && offset+len(page.Bounces) >= page.TotalCount {
			break // consumed the whole reported set
		}
	}
	return out, nil
}
