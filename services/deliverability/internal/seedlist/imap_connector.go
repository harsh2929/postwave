package seedlist

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/mail"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"github.com/postwave/postwave/services/deliverability/internal/seedlist/categorizers"
)

const (
	defaultIMAPPort                = 993
	defaultIMAPDialTimeout         = 30 * time.Second
	defaultCursorBootstrapLookback = 24 * time.Hour
	defaultMaxUIDsPerFolderPoll    = 1000
)

// IMAPConnector polls real seedlist mailboxes. It uses a selected-header
// BODY.PEEK fast path, then streams bounded BODY.PEEK[] bytes only for tagged
// messages. It never mutates \Seen.
type IMAPConnector struct {
	Folders []string
	// MarkSeen is retained for source compatibility but is intentionally
	// ignored. Seed acquisition must never change recipient mailbox state.
	MarkSeen        bool
	DialTimeout     time.Duration
	MaxRawMIMEBytes int64
	// DisableRawMIME is the rollout kill switch. The selected-header placement
	// path remains operational, while capability reporting and each message
	// explicitly say raw MIME is unavailable.
	DisableRawMIME          bool
	CursorBootstrapLookback time.Duration
	MaxUIDsPerFolderPoll    int
	Now                     func() time.Time
	dialTLS                 func(string, *imapclient.Options) (*imapclient.Client, error)
}

// NewIMAPConnectorFromEnv builds the production seed-list connector. The
// folder list intentionally covers common providers; missing folders are
// skipped per inbox so Gmail/Outlook/Yahoo can share one connector.
func NewIMAPConnectorFromEnv() *IMAPConnector {
	folders := splitCSV(os.Getenv("SEEDLIST_IMAP_FOLDERS"))
	if len(folders) == 0 {
		folders = []string{
			"INBOX",
			"Promotions",
			"Updates",
			"Social",
			"Spam",
			"Junk",
			"Junk Email",
			"Bulk Mail",
		}
	}
	return &IMAPConnector{
		Folders:                 folders,
		DialTimeout:             defaultIMAPDialTimeout,
		MaxRawMIMEBytes:         rawMIMELimitFromEnv(),
		CursorBootstrapLookback: defaultCursorBootstrapLookback,
		MaxUIDsPerFolderPoll:    defaultMaxUIDsPerFolderPoll,
		Now:                     time.Now,
	}
}

// Capabilities reports connector features independently. A successful IMAP
// placement result does not imply an observed provider/client AI surface.
func (c *IMAPConnector) Capabilities() ConnectorCapabilities {
	if c != nil && c.DisableRawMIME {
		return ConnectorCapabilities{
			Headers: CapabilityAvailable, RawMIME: CapabilityUnavailable,
			BodyParts: CapabilityUnavailable, Placement: CapabilityAvailable,
			ObservedSurface: CapabilityUnavailable,
		}
	}
	return ConnectorCapabilities{
		Headers:         CapabilityAvailable,
		RawMIME:         CapabilityAvailable,
		BodyParts:       CapabilityAvailable,
		Placement:       CapabilityAvailable,
		ObservedSurface: CapabilityUnavailable,
	}
}

func (c *IMAPConnector) FetchTaggedMessages(ctx context.Context, in *Inbox, since time.Time) ([]categorizers.Message, error) {
	if in == nil {
		return nil, errors.New("seedlist imap: nil inbox")
	}
	host := strings.TrimSpace(in.IMAPHost)
	if host == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing imap_host", in.ID)
	}
	user := strings.TrimSpace(in.IMAPUser)
	if user == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing imap_user", in.ID)
	}
	password := in.Password()
	if password == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing password env %s", in.ID, in.IMAPPasswordEnv)
	}
	port := in.IMAPPort
	if port == 0 {
		port = defaultIMAPPort
	}
	addr := fmt.Sprintf("%s:%d", host, port)

	dialTimeout := c.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = defaultIMAPDialTimeout
	}
	dialTLS := c.dialTLS
	if dialTLS == nil {
		dialTLS = imapclient.DialTLS
	}
	client, err := dialTLS(addr, &imapclient.Options{
		Dialer: &net.Dialer{Timeout: dialTimeout},
	})
	if err != nil {
		return nil, fmt.Errorf("seedlist imap: dial %s: %w", addr, err)
	}
	defer func() { _ = client.Close() }()

	if err := client.Login(user, password).Wait(); err != nil {
		return nil, fmt.Errorf("seedlist imap: login %s: %w", user, err)
	}
	defer func() { _ = client.Logout().Wait() }()

	folders := c.Folders
	if len(folders) == 0 {
		folders = []string{"INBOX"}
	}

	var out []categorizers.Message
	var selected int
	for _, folder := range folders {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		folder = strings.TrimSpace(folder)
		if folder == "" {
			continue
		}
		msgs, err := c.fetchFolder(ctx, client, folder, since)
		if err != nil {
			if selected > 0 && isLikelyMissingMailbox(err) {
				continue
			}
			if selected == 0 && isLikelyMissingMailbox(err) {
				continue
			}
			return nil, err
		}
		selected++
		out = append(out, msgs...)
	}
	return out, nil
}

// FetchTaggedMessagesFromCursors uses UID ranges rather than IMAP's
// date-granularity SINCE search. On first observation or UIDVALIDITY reset it
// applies a bounded bootstrap lookback, then advances in capped UID batches so
// a large mailbox can never create an unbounded poll.
func (c *IMAPConnector) FetchTaggedMessagesFromCursors(ctx context.Context, in *Inbox, cursors map[string]FolderCursor) (CursorMessageBatch, error) {
	if in == nil {
		return CursorMessageBatch{}, errors.New("seedlist imap: nil inbox")
	}
	client, err := c.openClient(in)
	if err != nil {
		return CursorMessageBatch{}, err
	}
	defer func() { _ = client.Close() }()
	defer func() { _ = client.Logout().Wait() }()

	folders := c.Folders
	if len(folders) == 0 {
		folders = []string{"INBOX"}
	}
	batch := CursorMessageBatch{}
	selectedFolders := 0
	for _, rawFolder := range folders {
		if ctx.Err() != nil {
			return CursorMessageBatch{}, ctx.Err()
		}
		folder := strings.TrimSpace(rawFolder)
		if folder == "" {
			continue
		}
		cursor, hasCursor := cursors[folder]
		messages, watermark, err := c.fetchFolderFromCursor(ctx, client, folder, cursor, hasCursor)
		if err != nil {
			if isLikelyMissingMailbox(err) {
				continue
			}
			return CursorMessageBatch{}, err
		}
		selectedFolders++
		batch.Messages = append(batch.Messages, messages...)
		batch.Watermarks = append(batch.Watermarks, watermark)
	}
	if selectedFolders == 0 && len(folders) > 0 {
		return CursorMessageBatch{}, errors.New("seedlist imap: none of the configured folders exists")
	}
	return batch, nil
}

func (c *IMAPConnector) openClient(in *Inbox) (*imapclient.Client, error) {
	host := strings.TrimSpace(in.IMAPHost)
	if host == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing imap_host", in.ID)
	}
	user := strings.TrimSpace(in.IMAPUser)
	if user == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing imap_user", in.ID)
	}
	password := in.Password()
	if password == "" {
		return nil, fmt.Errorf("seedlist imap: inbox %s missing password env %s", in.ID, in.IMAPPasswordEnv)
	}
	port := in.IMAPPort
	if port == 0 {
		port = defaultIMAPPort
	}
	address := fmt.Sprintf("%s:%d", host, port)
	dialTimeout := c.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = defaultIMAPDialTimeout
	}
	dialTLS := c.dialTLS
	if dialTLS == nil {
		dialTLS = imapclient.DialTLS
	}
	client, err := dialTLS(address, &imapclient.Options{Dialer: &net.Dialer{Timeout: dialTimeout}})
	if err != nil {
		return nil, fmt.Errorf("seedlist imap: dial %s: %w", address, err)
	}
	if err := client.Login(user, password).Wait(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("seedlist imap: login %s: %w", user, err)
	}
	return client, nil
}

func (c *IMAPConnector) fetchFolderFromCursor(ctx context.Context, client *imapclient.Client, folder string, cursor FolderCursor, hasCursor bool) ([]categorizers.Message, FolderWatermark, error) {
	selected, err := client.Select(folder, nil).Wait()
	if err != nil {
		return nil, FolderWatermark{}, fmt.Errorf("seedlist imap: select %q: %w", folder, err)
	}
	if selected.UIDValidity == 0 {
		return nil, FolderWatermark{}, fmt.Errorf("seedlist imap: select %q did not provide UIDVALIDITY", folder)
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	watermark := FolderWatermark{Folder: folder, UIDValidity: selected.UIDValidity, ObservedAt: now}
	criteria := &imap.SearchCriteria{}
	bootstrap := !hasCursor || cursor.UIDValidity != selected.UIDValidity
	if !bootstrap {
		watermark.LastUID = cursor.LastUID
		if cursor.LastUID == ^uint32(0) {
			return nil, watermark, nil
		}
		if selected.UIDNext > 0 && cursor.LastUID >= uint32(selected.UIDNext-1) {
			return nil, watermark, nil
		}
		var uidRange imap.UIDSet
		uidRange.AddRange(imap.UID(cursor.LastUID+1), 0)
		criteria.UID = []imap.UIDSet{uidRange}
	} else {
		lookback := c.CursorBootstrapLookback
		if lookback <= 0 || lookback > 30*24*time.Hour {
			lookback = defaultCursorBootstrapLookback
		}
		criteria.Since = now.Add(-lookback)
	}
	searchData, err := client.UIDSearch(criteria, nil).Wait()
	if err != nil {
		return nil, FolderWatermark{}, fmt.Errorf("seedlist imap: cursor search %q: %w", folder, err)
	}
	uids := searchData.AllUIDs()
	if !bootstrap {
		// Some servers interpret N:* as N:current-max and return current-max
		// when N is beyond it. Enforce the monotonic boundary client-side too.
		uids = filterUIDsAfter(uids, cursor.LastUID)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	matchingUIDCount := len(uids)
	maxUIDs := c.MaxUIDsPerFolderPoll
	if maxUIDs <= 0 || maxUIDs > 10000 {
		maxUIDs = defaultMaxUIDsPerFolderPoll
	}
	if len(uids) > maxUIDs {
		uids = uids[:maxUIDs]
	}
	if len(uids) == 0 {
		if bootstrap {
			if selected.UIDNext == 0 {
				return nil, FolderWatermark{}, fmt.Errorf("seedlist imap: select %q did not provide UIDNEXT for bounded bootstrap", folder)
			}
			watermark.LastUID = uint32(selected.UIDNext - 1)
		}
		return nil, watermark, nil
	}
	watermark.LastUID = uint32(uids[len(uids)-1])
	// Once the whole bounded-bootstrap result fits in this pass, advance over
	// older pre-lookback messages too. Otherwise a quiet next poll would start
	// at UID 1 and accidentally backfill the mailbox's entire history.
	if bootstrap && matchingUIDCount <= maxUIDs && selected.UIDNext > 0 {
		lastExistingUID := uint32(selected.UIDNext - 1)
		if lastExistingUID > watermark.LastUID {
			watermark.LastUID = lastExistingUID
		}
	}
	messages, err := c.fetchTaggedUIDs(ctx, client, folder, uids, selected.UIDValidity, time.Time{})
	if err != nil {
		return nil, FolderWatermark{}, err
	}
	return messages, watermark, nil
}

func filterUIDsAfter(uids []imap.UID, lastUID uint32) []imap.UID {
	filtered := uids[:0]
	for _, uid := range uids {
		if uint32(uid) > lastUID {
			filtered = append(filtered, uid)
		}
	}
	return filtered
}

func (c *IMAPConnector) fetchFolder(ctx context.Context, client *imapclient.Client, folder string, since time.Time) ([]categorizers.Message, error) {
	selected, err := client.Select(folder, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("seedlist imap: select %q: %w", folder, err)
	}

	criteria := &imap.SearchCriteria{}
	if !since.IsZero() {
		criteria.Since = since
	}
	searchData, err := client.UIDSearch(criteria, nil).Wait()
	if err != nil {
		return nil, fmt.Errorf("seedlist imap: search %q: %w", folder, err)
	}
	uids := searchData.AllUIDs()
	if len(uids) == 0 {
		return nil, nil
	}
	return c.fetchTaggedUIDs(ctx, client, folder, uids, selected.UIDValidity, since)
}

func (c *IMAPConnector) fetchTaggedUIDs(ctx context.Context, client *imapclient.Client, folder string, uids []imap.UID, uidValidity uint32, since time.Time) ([]categorizers.Message, error) {
	bodySection := &imap.FetchItemBodySection{
		Specifier: imap.PartSpecifierHeader,
		HeaderFields: []string{
			PostwaveTestHeader,
			"Message-ID",
			"Subject",
			"From",
			"To",
			"Date",
			"X-GM-LABELS",
			"X-Gmail-Labels",
			"X-GM-THRID",
			"Thread-ID",
		},
		Peek: true,
	}
	fetchOpts := &imap.FetchOptions{
		UID:          true,
		InternalDate: true,
		RFC822Size:   true,
		BodySection:  []*imap.FetchItemBodySection{bodySection},
	}
	maxRawMIMEBytes := c.MaxRawMIMEBytes
	if maxRawMIMEBytes <= 0 || maxRawMIMEBytes > maxConfiguredMIMEBytes {
		maxRawMIMEBytes = DefaultMaxRawMIMEBytes
	}

	var out []categorizers.Message
	for _, uid := range uids {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		msgs, err := client.Fetch(imap.UIDSetNum(uid), fetchOpts).Collect()
		if err != nil {
			return nil, fmt.Errorf("seedlist imap: fetch %q uid %d: %w", folder, uid, err)
		}
		if len(msgs) == 0 {
			continue
		}
		msg := msgs[0]
		if !since.IsZero() && !msg.InternalDate.IsZero() && !msg.InternalDate.After(since) {
			continue
		}
		body := msg.FindBodySection(bodySection)
		if len(body) == 0 {
			continue
		}
		headers := parseSeedHeaders(body)
		if strings.TrimSpace(headers[PostwaveTestHeader]) == "" {
			continue
		}
		var rawMIME *categorizers.RawMIMEAcquisition
		if c.DisableRawMIME {
			rawMIME = unavailableRawMIME(rawMIMESourceIMAP, "raw_mime_capture_disabled", maxRawMIMEBytes)
			rawMIME.UID = uint32(uid)
			rawMIME.UIDValidity = uidValidity
			rawMIME.ReportedBytes = msg.RFC822Size
		} else {
			var rawErr error
			rawMIME, rawErr = c.fetchRawMIME(client, uid, msg.RFC822Size, maxRawMIMEBytes, uidValidity)
			if rawErr != nil {
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				rawMIME = failedRawMIME("imap_body_fetch_failed", msg.RFC822Size, maxRawMIMEBytes, uint32(uid), uidValidity)
			}
		}
		out = append(out, categorizers.Message{
			Folder:      folder,
			Labels:      seedLabels(headers),
			Headers:     headers,
			ReceivedAt:  msg.InternalDate.UTC(),
			UID:         uint32(uid),
			UIDValidity: uidValidity,
			RawMIME:     rawMIME,
		})
	}
	return out, nil
}

func (c *IMAPConnector) fetchRawMIME(client *imapclient.Client, uid imap.UID, reportedBytes, maxBytes int64, uidValidity uint32) (*categorizers.RawMIMEAcquisition, error) {
	section := &imap.FetchItemBodySection{
		Peek: true,
		Partial: &imap.SectionPartial{
			Offset: 0,
			Size:   maxBytes + 1,
		},
	}
	cmd := client.Fetch(imap.UIDSetNum(uid), &imap.FetchOptions{
		UID:         true,
		BodySection: []*imap.FetchItemBodySection{section},
	})
	var raw []byte
	var truncated bool
	for data := cmd.Next(); data != nil; data = cmd.Next() {
		for item := data.Next(); item != nil; item = data.Next() {
			body, ok := item.(imapclient.FetchItemDataBodySection)
			if !ok || !body.MatchCommand(section) || body.Literal == nil {
				continue
			}
			captured, wasTruncated, err := readLiteralBounded(body.Literal, maxBytes)
			if err != nil {
				_ = cmd.Close()
				return nil, err
			}
			raw = captured
			truncated = wasTruncated
		}
	}
	if err := cmd.Close(); err != nil {
		return nil, err
	}
	if raw == nil {
		return failedRawMIME("imap_body_missing", reportedBytes, maxBytes, uint32(uid), uidValidity), nil
	}
	return finalizeRawMIME(raw, reportedBytes, maxBytes, uint32(uid), uidValidity, truncated), nil
}

func readLiteralBounded(r io.Reader, maxBytes int64) ([]byte, bool, error) {
	if maxBytes <= 0 || maxBytes > maxConfiguredMIMEBytes {
		return nil, false, errors.New("seedlist imap: invalid raw MIME byte limit")
	}
	b, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, false, err
	}
	if int64(len(b)) > maxBytes {
		return b[:maxBytes], true, nil
	}
	return b, false, nil
}

func parseSeedHeaders(raw []byte) map[string]string {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return map[string]string{}
	}
	headers := map[string]string{}
	for _, key := range []string{
		PostwaveTestHeader,
		"Message-ID",
		"Subject",
		"From",
		"To",
		"Date",
		"X-GM-LABELS",
		"X-Gmail-Labels",
		"X-GM-THRID",
		"Thread-ID",
	} {
		if v := strings.TrimSpace(msg.Header.Get(key)); v != "" {
			headers[key] = v
		}
	}
	return headers
}

func seedLabels(headers map[string]string) []string {
	raw := headers["X-GM-LABELS"]
	if raw == "" {
		raw = headers["X-Gmail-Labels"]
	}
	labels := splitCSV(strings.NewReplacer("\\", "", "\"", "").Replace(raw))
	for i := range labels {
		labels[i] = strings.ToUpper(strings.TrimSpace(labels[i]))
	}
	return labels
}

func splitCSV(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func rawMIMELimitFromEnv() int64 {
	raw := strings.TrimSpace(os.Getenv("SEEDLIST_IMAP_MAX_MIME_BYTES"))
	if raw == "" {
		return DefaultMaxRawMIMEBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 || value > maxConfiguredMIMEBytes {
		return DefaultMaxRawMIMEBytes
	}
	return value
}

func isLikelyMissingMailbox(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "doesn't exist") ||
		strings.Contains(msg, "does not exist") ||
		strings.Contains(msg, "not found") ||
		strings.Contains(msg, "no such mailbox") ||
		strings.Contains(msg, "unknown mailbox")
}
