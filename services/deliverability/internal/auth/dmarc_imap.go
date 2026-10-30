// IMAP poller for DMARC aggregate reports.
//
// Mailboxes the rua= contact on Moosewave's auth-reporting domain (Google,
// Yahoo, Microsoft and others mail compressed XML reports daily). Pull
// model: every Interval we open an IMAP connection, look for UNSEEN
// messages, extract the gz/zip XML attachment, parse, persist, and mark
// the message Seen. Re-running pollOnce after a partial failure does not
// double-insert because Persist is idempotent on (tenant, org, report_id).
//
// Tenant resolution strategy (in order):
//  1. Plus-addressed envelope-To matching `dmarc-tenant-<uuid>@<domain>` —
//     each tenant gets a unique receive address printed in onboarding.
//  2. Otherwise the report's policy_published.domain is matched against
//     send_domains to find the owning tenant. Best-effort SQL lookup; if
//     the table doesn't exist (older deploys) the report is left unmapped.
//  3. No fallback tenant is permitted: unmapped reports are quarantined by
//     omission and counted as {result=unmapped}.

package auth

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/mail"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// dmarcReportsIngested counts every report we attempted to ingest, broken
// down by terminal status. Cardinality is bounded (4 fixed labels).
var dmarcReportsIngested = promauto.NewCounterVec(prometheus.CounterOpts{
	Name: "dmarc_reports_ingested_total",
	Help: "Total DMARC aggregate reports observed by the IMAP poller, partitioned by outcome (success/duplicate/error/unmapped).",
}, []string{"result"})

// Default poller knobs — overridable via env in PollerFromEnv.
const (
	defaultIMAPFolder   = "INBOX"
	defaultPollInterval = 15 * time.Minute
	maxBackoff          = 60 * time.Second
	dialTimeout         = 30 * time.Second

	maxRawDMARCMessageBytes       = 25 << 20 // 25 MiB raw RFC822 message cap after IMAP fetch.
	maxDMARCCompressedPartBytes   = 10 << 20 // 10 MiB compressed attachment/body cap.
	maxDMARCEncodedPartBytes      = 14 << 20 // enough base64 headroom for a 10 MiB compressed part.
	maxDMARCDecompressedXMLBytes  = 5 << 20  // 5 MiB decompressed XML cap.
	maxDMARCXMLAttachmentsPerMail = 20
)

// Poller polls an IMAP inbox for DMARC aggregate reports.
type Poller struct {
	Host     string
	Port     int
	User     string
	Password string
	Folder   string
	Store    *Store
	Interval time.Duration

	// Logger is optional; falls back to slog.Default().
	Logger *slog.Logger

	// TenantResolver is the strategy used to map an inbound report to a
	// tenant. The default uses ResolveTenant which inspects envelope-To
	// then the report's policy_published.domain.
	TenantResolver TenantResolver
}

// TenantResolver returns the tenant id (UUID string) a given report
// belongs to. Implementations may consult the message envelope, the
// parsed report, or both. Returning ("", nil) signals "unmappable —
// skip this report".
type TenantResolver interface {
	Resolve(ctx context.Context, env *imap.Envelope, parsed *Report) (string, error)
}

// envelopeToTenantRegex matches the plus-addressed receive-address shape
// the onboarding flow assigns each tenant. Anchored host-side so it
// can't accidentally match a free-form display name.
var envelopeToTenantRegex = regexp.MustCompile(`(?i)dmarc-tenant-([0-9a-f-]{36})@`)

// SendDomainLookup is the narrow surface DefaultTenantResolver needs
// from a send-domain client. The concrete *SendDomainClient in this
// package satisfies it; tests inject a fake to avoid spinning up an
// httptest.Server.
type SendDomainLookup interface {
	LookupTenant(ctx context.Context, domain string) (string, error)
}

// DefaultTenantResolver implements the legacy resolution order. The legacy
// IMAP poller is disabled by default because an IMAP envelope does not provide
// a trusted SMTP recipient or authentication verdict.
type DefaultTenantResolver struct {
	// SendDomainClient is the cross-service lookup used in step 2.
	// Optional: when nil, the policy_published.domain step is skipped
	// entirely and Resolve returns an unmapped error.
	SendDomainClient SendDomainLookup
}

// Resolve walks the resolution strategy:
//  1. plus-addressed envelope-To
//  2. policy_published.domain → SendDomainClient.LookupTenant
//     (skipped silently when SendDomainClient is nil; ErrNotFound is
//     a soft miss; transport errors are logged + treated as a miss
//     so a flaky gateway doesn't lose reports)
//  3. unmapped. A global fallback would be a cross-tenant confused deputy.
func (d DefaultTenantResolver) Resolve(ctx context.Context, env *imap.Envelope, parsed *Report) (string, error) {
	// (1) plus-addressed envelope-To.
	if env != nil {
		for _, to := range env.To {
			addr := to.Addr()
			if id := extractTenantFromAddress(addr); id != "" {
				return id, nil
			}
		}
	}
	// (2) policy_published.domain → SendDomainClient.
	if d.SendDomainClient != nil && parsed != nil {
		domain := strings.TrimSpace(parsed.PolicyPub.Domain)
		if domain != "" {
			id, err := d.SendDomainClient.LookupTenant(ctx, domain)
			if err == nil && id != "" {
				return id, nil
			}
			if err != nil && !errors.Is(err, ErrNotFound) {
				slog.Warn("sendomain lookup error during dmarc resolution",
					"domain", domain, "err", err.Error())
			}
		}
	}
	// (3) unmapped. Never assign hostile evidence to an arbitrary tenant.
	if parsed != nil && parsed.PolicyPub.Domain != "" {
		// Surface the unmappable domain via error so the poller can log
		// useful context.
		return "", fmt.Errorf("no tenant mapping for domain %q", parsed.PolicyPub.Domain)
	}
	return "", errors.New("no tenant mapping")
}

// extractTenantFromAddress pulls the tenant uuid from a recipient address
// of the form `dmarc-tenant-<uuid>@<host>`. Returns "" if the shape doesn't
// match. Exposed-as-helper so tests don't need to construct an *imap.Envelope.
func extractTenantFromAddress(addr string) string {
	m := envelopeToTenantRegex.FindStringSubmatch(addr)
	if len(m) == 2 {
		return m[1]
	}
	return ""
}

// PollerFromEnv constructs the legacy IMAP poller from DMARC_IMAP_* variables.
// It is intentionally default-off. IMAP message headers do not prove the SMTP
// recipient or the report email's DMARC verdict, so enabling this path requires
// the conspicuous break-glass DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION=true
// flag. Production qualification must reject that flag; it exists only for
// isolated migration/research environments.
func PollerFromEnv(store *Store, logger *slog.Logger) (*Poller, error) {
	if !strings.EqualFold(strings.TrimSpace(os.Getenv("DMARC_IMAP_ALLOW_UNTRUSTED_LEGACY_INGESTION")), "true") {
		return nil, nil
	}
	host := strings.TrimSpace(os.Getenv("DMARC_IMAP_HOST"))
	if host == "" {
		return nil, nil
	}
	portStr := strings.TrimSpace(os.Getenv("DMARC_IMAP_PORT"))
	port := 993
	if portStr != "" {
		p, err := strconv.Atoi(portStr)
		if err != nil {
			return nil, fmt.Errorf("DMARC_IMAP_PORT %q: %w", portStr, err)
		}
		port = p
	}
	user := os.Getenv("DMARC_IMAP_USER")
	pw := os.Getenv("DMARC_IMAP_PASSWORD")
	if strings.TrimSpace(user) == "" {
		return nil, errors.New("DMARC_IMAP_USER is required when legacy IMAP ingestion is enabled")
	}
	if pw == "" {
		// Indirection for a secrets-manager backed value. The actual
		// resolver lives outside this package; today we simply observe
		// that a secret is referenced and refuse to start without env
		// fallback. Wiring the resolver is left to ops.
		if name := os.Getenv("DMARC_IMAP_PASSWORD_SECRET_NAME"); name != "" {
			return nil, fmt.Errorf("DMARC_IMAP_PASSWORD_SECRET_NAME=%s set but no resolver wired in this package; provide DMARC_IMAP_PASSWORD env or wire the resolver in main.go", name)
		}
		return nil, errors.New("DMARC_IMAP_PASSWORD is required when legacy IMAP ingestion is enabled")
	}
	folder := strings.TrimSpace(os.Getenv("DMARC_IMAP_FOLDER"))
	if folder == "" {
		folder = defaultIMAPFolder
	}
	interval := defaultPollInterval
	if v := strings.TrimSpace(os.Getenv("DMARC_IMAP_INTERVAL_SECONDS")); v != "" {
		secs, err := strconv.Atoi(v)
		if err != nil || secs <= 0 {
			return nil, fmt.Errorf("DMARC_IMAP_INTERVAL_SECONDS %q: must be a positive integer", v)
		}
		interval = time.Duration(secs) * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Poller{
		Host:           host,
		Port:           port,
		User:           user,
		Password:       pw,
		Folder:         folder,
		Store:          store,
		Interval:       interval,
		Logger:         logger,
		TenantResolver: DefaultTenantResolver{},
	}, nil
}

// Run loops on Interval calling pollOnce. Each iteration is wrapped in
// reconnect-with-backoff so a flaky network doesn't kill the worker.
func (p *Poller) Run(ctx context.Context) {
	if p.Interval <= 0 {
		p.Interval = defaultPollInterval
	}
	if p.Folder == "" {
		p.Folder = defaultIMAPFolder
	}
	if p.Logger == nil {
		p.Logger = slog.Default()
	}
	if p.TenantResolver == nil {
		p.TenantResolver = DefaultTenantResolver{}
	}

	backoff := time.Second
	// Run an immediate first poll so on startup we don't sit idle for
	// the whole interval before doing useful work.
	if err := p.safePollOnce(ctx); err != nil {
		p.Logger.Warn("dmarc poller: first poll failed", "err", err)
		backoff = nextBackoff(backoff)
	} else {
		backoff = time.Second
	}

	timer := time.NewTimer(p.Interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := p.safePollOnce(ctx); err != nil {
				p.Logger.Warn("dmarc poller: pollOnce failed; backing off", "err", err, "backoff", backoff.String())
				// Wait the backoff (unless ctx cancels) before resuming
				// the regular ticker.
				select {
				case <-ctx.Done():
					return
				case <-time.After(backoff):
				}
				backoff = nextBackoff(backoff)
			} else {
				backoff = time.Second
			}
			timer.Reset(p.Interval)
		}
	}
}

func (p *Poller) safePollOnce(ctx context.Context) error {
	return recoverPoll("dmarc poller", func() error {
		return p.pollOnce(ctx)
	})
}

func recoverPoll(scope string, run func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%s panic: %v", scope, r)
		}
	}()
	return run()
}

// nextBackoff doubles the duration up to maxBackoff.
func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > maxBackoff {
		return maxBackoff
	}
	return d
}

// pollOnce does one IMAP transaction: connect, login, select, search
// UNSEEN, fetch + ingest, mark Seen. Per-message errors don't abort the
// whole batch — we tally them in the counter and move on.
func (p *Poller) pollOnce(ctx context.Context) error {
	if p.Store == nil {
		return errors.New("dmarc poller: nil store")
	}
	addr := fmt.Sprintf("%s:%d", p.Host, p.Port)

	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	_ = dctx // dial doesn't take ctx; deadline is enforced via tcp-level connect timeouts

	c, err := imapclient.DialTLS(addr, &imapclient.Options{})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer func() { _ = c.Close() }()

	if err := c.Login(p.User, p.Password).Wait(); err != nil {
		return fmt.Errorf("login: %w", err)
	}
	defer func() { _ = c.Logout().Wait() }()

	if _, err := c.Select(p.Folder, nil).Wait(); err != nil {
		return fmt.Errorf("select %q: %w", p.Folder, err)
	}

	// UID search for UNSEEN — the UID set we get back is what we use for
	// the subsequent FETCH/STORE commands so the operation is stable
	// across new arrivals during the batch.
	searchData, err := c.UIDSearch(&imap.SearchCriteria{
		NotFlag: []imap.Flag{imap.FlagSeen},
	}, nil).Wait()
	if err != nil {
		return fmt.Errorf("search: %w", err)
	}
	uids := searchData.AllUIDs()
	if len(uids) == 0 {
		p.Logger.Debug("dmarc poller: no unseen messages")
		return nil
	}

	bodySection := &imap.FetchItemBodySection{}
	fetchOpts := &imap.FetchOptions{
		UID:         true,
		Envelope:    true,
		BodySection: []*imap.FetchItemBodySection{bodySection},
	}
	for _, uid := range uids {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msgs, err := c.Fetch(imap.UIDSetNum(uid), fetchOpts).Collect()
		if err != nil {
			p.Logger.Warn("dmarc poller: fetch failed", "uid", uid, "err", err)
			dmarcReportsIngested.WithLabelValues("error").Inc()
			continue
		}
		if len(msgs) == 0 {
			continue
		}
		msg := msgs[0]
		body := msg.FindBodySection(bodySection)
		if len(body) == 0 {
			p.Logger.Warn("dmarc poller: empty body", "uid", uid)
			dmarcReportsIngested.WithLabelValues("error").Inc()
			continue
		}
		result := p.ingestRawMessage(ctx, msg.Envelope, body)
		dmarcReportsIngested.WithLabelValues(result).Inc()

		// Mark Seen on success+duplicate so we don't re-process. On
		// "error" or "unmapped" we leave UNSEEN so a human can review.
		if result == "success" || result == "duplicate" {
			storeFlags := &imap.StoreFlags{
				Op:     imap.StoreFlagsAdd,
				Flags:  []imap.Flag{imap.FlagSeen},
				Silent: true,
			}
			if err := c.Store(imap.UIDSetNum(uid), storeFlags, nil).Close(); err != nil {
				p.Logger.Warn("dmarc poller: STORE Seen failed", "uid", uid, "err", err)
			}
		}
	}
	return nil
}

// ingestRawMessage extracts the report attachment, parses, resolves the
// tenant, and persists. Returns one of the canonical result labels for
// the counter: "success" / "duplicate" / "error" / "unmapped".
func (p *Poller) ingestRawMessage(ctx context.Context, env *imap.Envelope, raw []byte) string {
	xmlReaders, err := extractDMARCAttachments(raw)
	if err != nil {
		p.Logger.Warn("dmarc poller: extract attachments failed", "err", err)
		return "error"
	}
	if len(xmlReaders) == 0 {
		p.Logger.Warn("dmarc poller: message had no DMARC-shaped attachments")
		return "error"
	}
	// Most DMARC reports carry a single attachment, but a few aggregator
	// services bundle multiple — handle the first one that parses.
	var lastResult string
	for _, rdr := range xmlReaders {
		parsed, err := ParseXML(rdr)
		if err != nil {
			p.Logger.Warn("dmarc poller: parse failed", "err", err)
			lastResult = "error"
			continue
		}
		tenantID, err := p.TenantResolver.Resolve(ctx, env, parsed)
		if err != nil || tenantID == "" {
			p.Logger.Warn("dmarc poller: unmapped report",
				"err", err,
				"domain", parsed.PolicyPub.Domain,
				"org", parsed.ReportMeta.OrgName,
			)
			lastResult = "unmapped"
			continue
		}
		sourceMessageID := ""
		if env != nil {
			sourceMessageID = env.MessageID
		}
		_, dup, err := p.Store.Persist(ctx, tenantID, parsed, sourceMessageID)
		if err != nil {
			p.Logger.Warn("dmarc poller: persist failed", "err", err)
			lastResult = "error"
			continue
		}
		if dup {
			lastResult = "duplicate"
			continue
		}
		// First success short-circuits (we still have the chance to log
		// later attachments above; for the counter we report success once).
		return "success"
	}
	if lastResult == "" {
		return "error"
	}
	return lastResult
}

// dmarcAttachmentMIMETypes is the set of content-types DMARC reports
// arrive as. octet-stream is included because some senders fail to set
// a meaningful type.
var dmarcAttachmentMIMETypes = map[string]struct{}{
	"application/zip":          {},
	"application/gzip":         {},
	"application/x-gzip":       {},
	"application/octet-stream": {},
}

// extractDMARCAttachments walks an RFC822 message and returns each
// decompressed XML report attachment as an io.Reader. A message may
// contain more than one attachment (aggregators bundle multiple), so
// we return a slice rather than a single reader.
func extractDMARCAttachments(raw []byte) ([]io.Reader, error) {
	if len(raw) > maxRawDMARCMessageBytes {
		return nil, fmt.Errorf("dmarc message exceeds %d bytes", maxRawDMARCMessageBytes)
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("parse rfc822: %w", err)
	}
	ct := msg.Header.Get("Content-Type")
	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil {
		// No content-type — try the whole body as a single attachment.
		body, err := readAllLimited(msg.Body, maxDMARCCompressedPartBytes, "single-part DMARC body")
		if err != nil {
			return nil, err
		}
		return decompressAttachment(mediaType, "", body)
	}

	var out []io.Reader
	if strings.HasPrefix(mediaType, "multipart/") {
		boundary := params["boundary"]
		if boundary == "" {
			return nil, errors.New("multipart without boundary")
		}
		mr := multipart.NewReader(msg.Body, boundary)
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, fmt.Errorf("multipart next: %w", err)
			}
			pct := part.Header.Get("Content-Type")
			pmt, _, _ := mime.ParseMediaType(pct)
			if _, ok := dmarcAttachmentMIMETypes[pmt]; !ok {
				_ = part.Close()
				continue
			}
			cte := part.Header.Get("Content-Transfer-Encoding")
			body, err := readPartBody(part, cte)
			_ = part.Close()
			if err != nil {
				return nil, fmt.Errorf("read part: %w", err)
			}
			disp := part.Header.Get("Content-Disposition")
			filename := extractFilename(disp, part.Header.Get("Content-Type"))
			rdrs, err := decompressAttachment(pmt, filename, body)
			if err != nil {
				return nil, err
			}
			out = append(out, rdrs...)
			if len(out) > maxDMARCXMLAttachmentsPerMail {
				return nil, fmt.Errorf("dmarc message has more than %d XML attachments", maxDMARCXMLAttachmentsPerMail)
			}
		}
		return out, nil
	}

	// Single-part message — treat the whole body as the attachment.
	body, err := readAllLimited(msg.Body, maxDMARCCompressedPartBytes, "single-part DMARC body")
	if err != nil {
		return nil, err
	}
	return decompressAttachment(mediaType, "", body)
}

// readPartBody handles base64 / quoted-printable / 7bit transfer encodings.
// (multipart.Part already strips the framing, so all that's left is the CTE.)
func readPartBody(part *multipart.Part, cte string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(cte)) {
	case "base64":
		// multipart.Reader doesn't auto-decode base64; do it ourselves.
		// (We use mime.WordDecoder only for headers; for bodies we have
		// to read all + decode.)
		all, err := readAllLimited(part, maxDMARCEncodedPartBytes, "base64 DMARC part")
		if err != nil {
			return nil, err
		}
		return base64Clean(all)
	default:
		return readAllLimited(part, maxDMARCCompressedPartBytes, "DMARC part")
	}
}

func readAllLimited(r io.Reader, maxBytes int64, label string) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%s exceeds %d bytes", label, maxBytes)
	}
	return data, nil
}

// base64Clean strips whitespace then base64-decodes.
func base64Clean(b []byte) ([]byte, error) {
	// Replace CRLF/whitespace.
	cleaned := make([]byte, 0, len(b))
	for _, c := range b {
		if c == '\r' || c == '\n' || c == ' ' || c == '\t' {
			continue
		}
		cleaned = append(cleaned, c)
	}
	dst := make([]byte, base64.StdEncoding.DecodedLen(len(cleaned)))
	n, err := base64.StdEncoding.Decode(dst, cleaned)
	if err != nil {
		return nil, err
	}
	return dst[:n], nil
}

// extractFilename pulls the filename from the Content-Disposition header,
// falling back to the name= param on Content-Type.
func extractFilename(disp, ct string) string {
	if disp != "" {
		if _, params, err := mime.ParseMediaType(disp); err == nil {
			if fn := params["filename"]; fn != "" {
				return fn
			}
		}
	}
	if ct != "" {
		if _, params, err := mime.ParseMediaType(ct); err == nil {
			if fn := params["name"]; fn != "" {
				return fn
			}
		}
	}
	return ""
}

// decompressAttachment turns a compressed attachment into one or more XML
// readers. It infers the format from the MIME type first, then the filename
// extension (DMARC reports frequently come labelled application/octet-stream
// with a .xml.gz filename).
func decompressAttachment(mediaType, filename string, body []byte) ([]io.Reader, error) {
	low := strings.ToLower(filename)
	switch {
	case mediaType == "application/zip" || strings.HasSuffix(low, ".zip"):
		zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
		if err != nil {
			return nil, fmt.Errorf("zip open: %w", err)
		}
		var out []io.Reader
		for _, f := range zr.File {
			if !strings.HasSuffix(strings.ToLower(f.Name), ".xml") {
				continue
			}
			if len(out) >= maxDMARCXMLAttachmentsPerMail {
				return nil, fmt.Errorf("zip has more than %d XML entries", maxDMARCXMLAttachmentsPerMail)
			}
			rc, err := f.Open()
			if err != nil {
				return nil, fmt.Errorf("zip entry %s: %w", f.Name, err)
			}
			data, err := readAllLimited(rc, maxDMARCDecompressedXMLBytes, "dmarc zip entry "+f.Name)
			_ = rc.Close()
			if err != nil {
				return nil, err
			}
			out = append(out, bytes.NewReader(data))
		}
		return out, nil
	case mediaType == "application/gzip" || mediaType == "application/x-gzip" ||
		strings.HasSuffix(low, ".gz") || strings.HasSuffix(low, ".gzip"):
		gr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("gzip open: %w", err)
		}
		defer func() { _ = gr.Close() }()
		data, err := readAllLimited(gr, maxDMARCDecompressedXMLBytes, "dmarc gzip payload")
		if err != nil {
			return nil, fmt.Errorf("gzip read: %w", err)
		}
		return []io.Reader{bytes.NewReader(data)}, nil
	default:
		// Plain XML — try to detect by the leading byte.
		trimmed := bytes.TrimLeft(body, " \t\r\n")
		if len(trimmed) > 0 && trimmed[0] == '<' {
			if len(body) > maxDMARCDecompressedXMLBytes {
				return nil, fmt.Errorf("plain dmarc xml exceeds %d bytes", maxDMARCDecompressedXMLBytes)
			}
			return []io.Reader{bytes.NewReader(body)}, nil
		}
		// Last-resort: assume gzip (some senders send raw .gz under
		// octet-stream with no filename hint).
		gr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("unrecognised attachment shape (mediaType=%q): %w", mediaType, err)
		}
		defer func() { _ = gr.Close() }()
		data, err := readAllLimited(gr, maxDMARCDecompressedXMLBytes, "dmarc gzip payload")
		if err != nil {
			return nil, err
		}
		return []io.Reader{bytes.NewReader(data)}, nil
	}
}
