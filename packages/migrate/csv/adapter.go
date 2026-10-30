// SPDX-License-Identifier: MIT

package csv

import (
	"context"
	encodingcsv "encoding/csv"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func init() {
	adapter.Register(canonical.SourceCSV, func() adapter.Adapter { return New() })
}

// Adapter implements adapter.Adapter for arbitrary CSV uploads.
type Adapter struct{}

const maxCSVFileBytes int64 = 200 << 20 // 200 MiB; matches the upload API and web app.

// New constructs a CSV adapter.
func New() *Adapter { return &Adapter{} }

// Capabilities — CSV only carries subscribers; segments/automations/etc. are
// out of scope for the universal importer.
func (a *Adapter) Capabilities() canonical.AdapterCapabilities {
	c := canonical.AdapterCapabilities{
		Source:     canonical.SourceCSV,
		AuthMethod: "csv_upload",
	}
	c.Supports.Subscribers = true
	c.Supports.Segments = false
	c.Supports.Automations = false
	c.Supports.CampaignArchive = false
	c.Supports.PaidSubs = false
	c.Supports.ConsentTimestamps = true
	c.Supports.Templates = false
	c.Supports.Campaigns = false
	c.Supports.Reports = false
	c.Supports.Groups = false
	c.Supports.Forms = false
	c.Supports.LandingPages = false
	c.Supports.Ecommerce = false
	return c
}

// Authenticate sniffs the CSV header + first 100 rows to build a column
// mapping. The mapping rides along on Session.AccessToken (JSON-encoded) so
// resume across restarts works without an external store.
//
// Required: creds.Extra["csv_path"]. Optional override: a fully pre-built
// mapping JSON in creds.Extra["mapping"].
func (a *Adapter) Authenticate(_ context.Context, creds adapter.Credentials) (adapter.Session, error) {
	if creds.Extra == nil || creds.Extra["csv_path"] == "" {
		return adapter.Session{}, fmt.Errorf("csv: csv_path required: %w", adapter.ErrAuth)
	}
	path := creds.Extra["csv_path"]
	f, err := openCSVFile(path)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("csv: open %q: %w: %w", path, adapter.ErrAuth, err)
	}
	defer func() { _ = f.Close() }()

	mp, _, err := DetectMapping(f)
	if err != nil {
		return adapter.Session{}, fmt.Errorf("csv: detect mapping: %w", err)
	}
	mp.Path = path

	// If caller pre-supplied a mapping, override the detected one.
	if creds.Extra["mapping"] != "" {
		user, err := DecodeMapping(creds.Extra["mapping"])
		if err != nil {
			return adapter.Session{}, fmt.Errorf("csv: invalid mapping: %w", err)
		}
		if len(user.Headers) != len(mp.Headers) {
			return adapter.Session{}, fmt.Errorf("csv: mapping headers differ from upload")
		}
		for i, h := range mp.Headers {
			if user.Headers[i] != h {
				return adapter.Session{}, fmt.Errorf("csv: mapping headers differ from upload")
			}
		}
		user.Path = path
		mp = user
	}

	mp.Profile = canonical.SourceCSV
	if err := validateMapping(mp); err != nil {
		return adapter.Session{}, err
	}
	if !hasEmailColumn(mp) {
		return adapter.Session{}, fmt.Errorf("csv: no email column detected: %w", adapter.ErrAuth)
	}

	encoded, err := EncodeMapping(mp)
	if err != nil {
		return adapter.Session{}, err
	}
	return adapter.Session{
		AccessToken: encoded,
		AccountID:   path,
		Source:      canonical.SourceCSV,
		Extra:       cloneMap(creds.Extra),
	}, nil
}

// Discover counts the same usable email rows that the importer can emit.
func (a *Adapter) Discover(ctx context.Context, sess adapter.Session) (adapter.DiscoveryReport, error) {
	mp, err := DecodeMapping(sess.AccessToken)
	if err != nil {
		return adapter.DiscoveryReport{}, err
	}
	f, err := openCSVFile(mp.Path)
	if err != nil {
		return adapter.DiscoveryReport{}, err
	}
	defer f.Close()
	reader := encodingcsv.NewReader(f)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	if _, err := readCSVRecord(reader); err != nil {
		return adapter.DiscoveryReport{}, err
	}
	var rep adapter.DiscoveryReport
	for {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		row, err := readCSVRecord(reader)
		if err == io.EOF {
			break
		}
		if err != nil {
			return rep, err
		}
		if _, ok := applyRow(row, mp); ok {
			rep.SubscribersTotal++
		} else {
			rep.ProfilesWithoutEmailTotal++
		}
	}
	if rep.ProfilesWithoutEmailTotal > 0 {
		rep.Warnings = append(rep.Warnings, fmt.Sprintf("Excluded %d rows without a usable email address.", rep.ProfilesWithoutEmailTotal))
	}
	rep.Warnings = append(rep.Warnings, "Include all subscription states and suppression exports. Missing or unrecognized email status stays unconfirmed. Creation dates are not consent evidence.")
	if mp.Profile == canonical.SourceCampaignMonitor {
		rep.Warnings = append(rep.Warnings, "Reconcile every list with the account suppression export before sending; a single list export does not establish account-wide completeness.")
	}
	if mp.Profile == canonical.SourceOmnisend {
		rep.Warnings = append(rep.Warnings, "Only email subscription status controls email eligibility; SMS and push permissions remain separate source fields.")
	}
	return rep, nil
}

// ListSubscribers streams the file from a row-index cursor, applies the
// mapping, and emits canonical Subscribers.
func (a *Adapter) ListSubscribers(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.Subscriber, string, error) {
	mp, err := DecodeMapping(sess.AccessToken)
	if err != nil {
		return nil, "", err
	}
	skip := 0
	if cursor != "" {
		var err error
		skip, err = strconv.Atoi(cursor)
		if err != nil || skip < 0 {
			return nil, "", fmt.Errorf("csv: invalid row cursor")
		}
	}
	f, err := openCSVFile(mp.Path)
	if err != nil {
		return nil, "", fmt.Errorf("csv: open %q: %w", mp.Path, err)
	}
	defer func() { _ = f.Close() }()

	reader := encodingcsv.NewReader(f)
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true

	// Drop header.
	if _, err := readCSVRecord(reader); err != nil {
		return nil, "", err
	}
	// Skip already-emitted rows.
	for i := 0; i < skip; i++ {
		if _, err := readCSVRecord(reader); err == io.EOF {
			return nil, "", fmt.Errorf("csv: resume cursor is beyond the uploaded rows")
		} else if err != nil {
			return nil, "", err
		}
	}

	const pageSize = 1000
	out := make([]canonical.Subscriber, 0, pageSize)
	emitted := 0
	for emitted < pageSize {
		if err := ctx.Err(); err != nil {
			return nil, "", err
		}
		rec, err := readCSVRecord(reader)
		if err == io.EOF {
			return out, "", nil
		}
		if err != nil {
			return nil, "", err
		}
		if sub, ok := applyRow(rec, mp); ok {
			out = append(out, sub)
		}
		emitted++
	}
	return out, strconv.Itoa(skip + emitted), nil
}

// ListSegments — unsupported.
func (a *Adapter) ListSegments(_ context.Context, _ adapter.Session) ([]canonical.Segment, error) {
	return nil, adapter.ErrUnsupported
}

// ListAutomations — unsupported.
func (a *Adapter) ListAutomations(_ context.Context, _ adapter.Session) ([]canonical.Automation, error) {
	return nil, adapter.ErrUnsupported
}

// ListCampaignArchive — unsupported.
func (a *Adapter) ListCampaignArchive(_ context.Context, _ adapter.Session, _ string) ([]canonical.CampaignArchive, string, error) {
	return nil, "", adapter.ErrUnsupported
}

// ListPaidSubs — unsupported.
func (a *Adapter) ListPaidSubs(_ context.Context, _ adapter.Session, _ string) ([]canonical.PaidSub, error) {
	return nil, adapter.ErrUnsupported
}

func cloneMap(in map[string]string) map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// --- helpers ---

func hasEmailColumn(m *Mapping) bool {
	for _, c := range m.Columns {
		if c.Kind == KindEmail {
			return true
		}
	}
	return false
}

func openCSVFile(path string) (*os.File, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxCSVFileBytes {
		return nil, fmt.Errorf("file exceeds %d bytes", maxCSVFileBytes)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	var prefix [4]byte
	n, _ := f.Read(prefix[:])
	_, _ = f.Seek(0, io.SeekStart)
	if n >= 2 && (strings.HasPrefix(string(prefix[:n]), "\xff\xfe") || strings.HasPrefix(string(prefix[:n]), "\xfe\xff")) {
		f.Close()
		return nil, fmt.Errorf("csv: save the export as UTF-8 CSV before uploading")
	}
	return f, nil
}
