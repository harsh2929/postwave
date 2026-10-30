// SPDX-License-Identifier: MIT

package substack

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxSubstackExportEntries           = 50_000
	maxSubstackExportUncompressedBytes = int64(1 << 30)   // 1 GiB
	maxSubstackExportEntryBytes        = int64(256 << 20) // 256 MiB
	substackAggregateStatsFile         = ".postwave-substack-post-statistics.csv"
)

type recipientStatsAggregate struct {
	deliveries int
	opens      int
}

// ExportManifest is non-content evidence describing the exact uploaded
// Substack export. It deliberately records names, sizes, and digests but never
// subscriber rows, delivery recipients, or open-recipient identities.
type ExportManifest struct {
	SchemaVersion int                   `json:"schema_version"`
	PreparedAt    time.Time             `json:"prepared_at"`
	UploadName    string                `json:"upload_name"`
	ArchiveSHA256 string                `json:"archive_sha256"`
	Entries       []ExportManifestEntry `json:"entries"`
}

type ExportManifestEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// PrepareUpload validates a plain subscriber CSV or safely expands an official
// Substack ZIP export beneath extractionRoot. The returned map is ready to pass
// as adapter.Credentials.Extra.
func PrepareUpload(uploadPath, extractionRoot, uploadName string) (map[string]string, error) {
	if strings.TrimSpace(uploadPath) == "" {
		return nil, fmt.Errorf("substack: upload path required")
	}
	f, err := os.Open(uploadPath)
	if err != nil {
		return nil, fmt.Errorf("substack: open upload: %w", err)
	}
	defer func() { _ = f.Close() }()

	var signature [4]byte
	n, readErr := io.ReadFull(f, signature[:])
	if readErr != nil && readErr != io.ErrUnexpectedEOF {
		return nil, fmt.Errorf("substack: read upload signature: %w", readErr)
	}
	isZIP := n == len(signature) && signature[0] == 'P' && signature[1] == 'K' &&
		(signature[2] == 3 || signature[2] == 5 || signature[2] == 7) &&
		(signature[3] == 4 || signature[3] == 6 || signature[3] == 8)
	if !isZIP {
		if err := validateSubscribersCSVPath(uploadPath); err != nil {
			return nil, err
		}
		return map[string]string{
			"subs_csv":  uploadPath,
			"file_name": firstNonEmpty(uploadName, filepath.Base(uploadPath)),
		}, nil
	}

	return prepareZIPUpload(uploadPath, extractionRoot, uploadName)
}

func prepareZIPUpload(uploadPath, extractionRoot, uploadName string) (map[string]string, error) {
	if strings.TrimSpace(extractionRoot) == "" {
		return nil, fmt.Errorf("substack: extraction root required for ZIP export")
	}
	st, err := os.Stat(uploadPath)
	if err != nil {
		return nil, fmt.Errorf("substack: stat ZIP export: %w", err)
	}
	zr, err := zip.OpenReader(uploadPath)
	if err != nil {
		return nil, fmt.Errorf("substack: invalid ZIP export: %w", err)
	}
	defer func() { _ = zr.Close() }()
	if len(zr.File) == 0 || len(zr.File) > maxSubstackExportEntries {
		return nil, fmt.Errorf("substack: ZIP contains %d entries; expected 1..%d", len(zr.File), maxSubstackExportEntries)
	}

	archiveDigest, err := sha256File(uploadPath)
	if err != nil {
		return nil, err
	}
	finalDir := filepath.Join(extractionRoot, "substack-export")
	completePath := filepath.Join(finalDir, ".complete")
	if marker, err := os.ReadFile(completePath); err == nil && strings.TrimSpace(string(marker)) == archiveDigest {
		return inspectPreparedExport(finalDir, uploadPath, uploadName)
	}

	stagingDir, err := os.MkdirTemp(extractionRoot, ".substack-export-")
	if err != nil {
		return nil, fmt.Errorf("substack: create extraction directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(stagingDir) }()

	manifest := ExportManifest{
		SchemaVersion: 1,
		PreparedAt:    time.Now().UTC(),
		UploadName:    firstNonEmpty(uploadName, filepath.Base(uploadPath)),
		ArchiveSHA256: archiveDigest,
		Entries:       make([]ExportManifestEntry, 0, len(zr.File)),
	}
	var declaredTotal int64
	var extractedTotal int64
	recipientStats := map[string]recipientStatsAggregate{}
	recipientStatsSeen := map[string]struct{}{}
	seenPaths := map[string]struct{}{}
	for _, entry := range zr.File {
		clean, err := safeZIPEntryPath(entry.Name)
		if err != nil {
			return nil, err
		}
		if entry.FileInfo().Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("substack: ZIP entry %q is a symbolic link", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			continue
		}
		pathKey := strings.ToLower(clean)
		if _, duplicate := seenPaths[pathKey]; duplicate {
			return nil, fmt.Errorf("substack: ZIP contains duplicate entry path %q", clean)
		}
		seenPaths[pathKey] = struct{}{}
		size := int64(entry.UncompressedSize64)
		if size < 0 || size > maxSubstackExportEntryBytes {
			return nil, fmt.Errorf("substack: ZIP entry %q exceeds the %d-byte limit", entry.Name, maxSubstackExportEntryBytes)
		}
		declaredTotal += size
		if declaredTotal > maxSubstackExportUncompressedBytes {
			return nil, fmt.Errorf("substack: ZIP expands beyond the %d-byte limit", maxSubstackExportUncompressedBytes)
		}

		// Substack's portable data is CSV plus HTML fragments. Do not expand
		// executables or unrelated archive payloads into service storage.
		ext := strings.ToLower(filepath.Ext(clean))
		if ext != ".csv" && ext != ".html" && ext != ".htm" && ext != ".md" {
			continue
		}

		// Per-recipient delivery and open exports contain email addresses. Count
		// them in-memory and retain only post-level aggregates; never materialize
		// those identity-bearing CSVs in service storage.
		lower := strings.ToLower(clean)
		if strings.HasSuffix(lower, ".delivers.csv") || strings.HasSuffix(lower, ".opens.csv") {
			postID := strings.TrimSpace(strings.SplitN(filepath.Base(clean), ".", 2)[0])
			if postID == "" {
				return nil, fmt.Errorf("substack: recipient-statistics entry %q has no post ID", entry.Name)
			}
			kind := "opens"
			if strings.HasSuffix(lower, ".delivers.csv") {
				kind = "deliveries"
			}
			statKey := strings.ToLower(postID) + "\x00" + kind
			if _, duplicate := recipientStatsSeen[statKey]; duplicate {
				return nil, fmt.Errorf("substack: multiple %s files match post %q", kind, postID)
			}
			recipientStatsSeen[statKey] = struct{}{}
			digest, written, count, err := summarizeZIPCSVEntry(entry)
			if err != nil {
				return nil, err
			}
			if written != size {
				return nil, fmt.Errorf("substack: ZIP entry %q size mismatch: read %d, expected %d", entry.Name, written, size)
			}
			extractedTotal += written
			if extractedTotal > maxSubstackExportUncompressedBytes {
				return nil, fmt.Errorf("substack: ZIP expands beyond the %d-byte limit", maxSubstackExportUncompressedBytes)
			}
			aggregate := recipientStats[postID]
			if kind == "deliveries" {
				aggregate.deliveries += count
			} else {
				aggregate.opens += count
			}
			recipientStats[postID] = aggregate
			manifest.Entries = append(manifest.Entries, ExportManifestEntry{Path: clean, Size: written, SHA256: digest})
			continue
		}
		destination := filepath.Join(stagingDir, filepath.FromSlash(clean))
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return nil, fmt.Errorf("substack: create ZIP directory: %w", err)
		}
		digest, written, err := extractZIPEntry(entry, destination)
		if err != nil {
			return nil, err
		}
		if written != size {
			return nil, fmt.Errorf("substack: ZIP entry %q size mismatch: read %d, expected %d", entry.Name, written, size)
		}
		extractedTotal += written
		if extractedTotal > maxSubstackExportUncompressedBytes {
			return nil, fmt.Errorf("substack: ZIP expands beyond the %d-byte limit", maxSubstackExportUncompressedBytes)
		}
		manifest.Entries = append(manifest.Entries, ExportManifestEntry{Path: clean, Size: written, SHA256: digest})
	}
	if st.Size() <= 0 || len(manifest.Entries) == 0 {
		return nil, fmt.Errorf("substack: ZIP contains no portable CSV or HTML export files")
	}
	if len(recipientStats) > 0 {
		if err := writeAggregateRecipientStats(filepath.Join(stagingDir, substackAggregateStatsFile), recipientStats); err != nil {
			return nil, err
		}
	}
	sort.Slice(manifest.Entries, func(i, j int) bool { return manifest.Entries[i].Path < manifest.Entries[j].Path })
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("substack: encode export manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, "manifest.json"), manifestBytes, 0o600); err != nil {
		return nil, fmt.Errorf("substack: write export manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(stagingDir, ".complete"), []byte(archiveDigest+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("substack: write extraction marker: %w", err)
	}
	if err := os.RemoveAll(finalDir); err != nil {
		return nil, fmt.Errorf("substack: replace prior extraction: %w", err)
	}
	if err := os.Rename(stagingDir, finalDir); err != nil {
		return nil, fmt.Errorf("substack: publish extracted export: %w", err)
	}
	return inspectPreparedExport(finalDir, uploadPath, uploadName)
}

func inspectPreparedExport(root, uploadPath, uploadName string) (map[string]string, error) {
	type csvCandidate struct {
		path  string
		score int
	}
	var subscriberCandidates []csvCandidate
	var postsCandidates []string
	err := filepath.WalkDir(root, func(filePath string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".csv") {
			return nil
		}
		headers, err := csvHeaderFromPath(filePath)
		if err != nil {
			return fmt.Errorf("substack: inspect %s: %w", entry.Name(), err)
		}
		base := strings.ToLower(entry.Name())
		if base == "posts.csv" {
			postsCandidates = append(postsCandidates, filePath)
		}
		if !headerHasAny(headers, "email", "email_address", "subscriber_email") {
			return nil
		}
		score := 0
		switch {
		case strings.HasPrefix(base, "email_list"):
			score += 100
		case strings.Contains(base, "subscriber"):
			score += 90
		case strings.Contains(base, "email"):
			score += 40
		}
		lowerPath := strings.ToLower(filepath.ToSlash(filePath))
		if strings.Contains(lowerPath, "/posts/") || strings.Contains(base, ".opens.") || strings.Contains(base, ".delivers.") {
			score -= 100
		}
		if headerHasAny(headers, "subscription_type", "subscription_status", "status", "state", "created_at", "subscription_date") {
			score += 20
		}
		subscriberCandidates = append(subscriberCandidates, csvCandidate{path: filePath, score: score})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(subscriberCandidates) == 0 {
		return nil, fmt.Errorf("substack: ZIP does not contain a subscriber CSV with an email column")
	}
	sort.Slice(subscriberCandidates, func(i, j int) bool {
		if subscriberCandidates[i].score == subscriberCandidates[j].score {
			return subscriberCandidates[i].path < subscriberCandidates[j].path
		}
		return subscriberCandidates[i].score > subscriberCandidates[j].score
	})
	if len(subscriberCandidates) > 1 && subscriberCandidates[0].score == subscriberCandidates[1].score {
		return nil, fmt.Errorf("substack: ZIP contains multiple equally likely subscriber CSVs (%s and %s)", filepath.Base(subscriberCandidates[0].path), filepath.Base(subscriberCandidates[1].path))
	}
	if err := validateSubscribersCSVPath(subscriberCandidates[0].path); err != nil {
		return nil, err
	}
	if len(postsCandidates) > 1 {
		return nil, fmt.Errorf("substack: ZIP contains multiple posts.csv files")
	}
	if len(postsCandidates) == 1 {
		f, err := os.Open(postsCandidates[0])
		if err != nil {
			return nil, fmt.Errorf("substack: open posts.csv: %w", err)
		}
		_, countErr := countPostsCSV(f)
		closeErr := f.Close()
		if countErr != nil {
			return nil, fmt.Errorf("substack: invalid posts.csv: %w", countErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("substack: close posts.csv: %w", closeErr)
		}
	}

	extra := map[string]string{
		"subs_csv":             subscriberCandidates[0].path,
		"archive_dir":          root,
		"bundle_path":          uploadPath,
		"bundle_manifest_path": filepath.Join(root, "manifest.json"),
		"file_name":            firstNonEmpty(uploadName, filepath.Base(uploadPath)),
	}
	if statsPath := filepath.Join(root, substackAggregateStatsFile); fileExists(statsPath) {
		extra["archive_stats_csv"] = statsPath
	}
	if len(postsCandidates) == 1 {
		extra["archive_csv"] = postsCandidates[0]
	}
	return extra, nil
}

func summarizeZIPCSVEntry(entry *zip.File) (string, int64, int, error) {
	r, err := entry.Open()
	if err != nil {
		return "", 0, 0, fmt.Errorf("substack: open ZIP entry %q: %w", entry.Name, err)
	}
	defer func() { _ = r.Close() }()

	h := sha256.New()
	counter := &byteCounter{}
	reader := csv.NewReader(io.TeeReader(io.LimitReader(r, maxSubstackExportEntryBytes+1), io.MultiWriter(h, counter)))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	if _, err := reader.Read(); err == io.EOF {
		return hex.EncodeToString(h.Sum(nil)), counter.n, 0, nil
	} else if err != nil {
		return "", counter.n, 0, fmt.Errorf("substack: read recipient-statistics header %q: %w", entry.Name, err)
	}
	count := 0
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", counter.n, count, fmt.Errorf("substack: read recipient-statistics row %q: %w", entry.Name, err)
		}
		for _, value := range record {
			if strings.TrimSpace(value) != "" {
				count++
				break
			}
		}
	}
	if counter.n > maxSubstackExportEntryBytes {
		return "", counter.n, count, fmt.Errorf("substack: ZIP entry %q exceeds the extraction limit", entry.Name)
	}
	return hex.EncodeToString(h.Sum(nil)), counter.n, count, nil
}

type byteCounter struct{ n int64 }

func (w *byteCounter) Write(p []byte) (int, error) {
	w.n += int64(len(p))
	return len(p), nil
}

func writeAggregateRecipientStats(destination string, stats map[string]recipientStatsAggregate) error {
	f, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("substack: create aggregate post statistics: %w", err)
	}
	w := csv.NewWriter(f)
	if err := w.Write([]string{"post_id", "recipients_count", "opens", "statistics_source"}); err != nil {
		_ = f.Close()
		return fmt.Errorf("substack: write aggregate post statistics header: %w", err)
	}
	ids := make([]string, 0, len(stats))
	for id := range stats {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		row := stats[id]
		if err := w.Write([]string{id, fmt.Sprintf("%d", row.deliveries), fmt.Sprintf("%d", row.opens), "substack_export_recipient_statistics"}); err != nil {
			_ = f.Close()
			return fmt.Errorf("substack: write aggregate post statistics: %w", err)
		}
	}
	w.Flush()
	if err := w.Error(); err != nil {
		_ = f.Close()
		return fmt.Errorf("substack: flush aggregate post statistics: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("substack: close aggregate post statistics: %w", err)
	}
	return nil
}

func fileExists(filePath string) bool {
	info, err := os.Stat(filePath)
	return err == nil && info.Mode().IsRegular()
}

func safeZIPEntryPath(raw string) (string, error) {
	raw = strings.ReplaceAll(raw, "\\", "/")
	if strings.ContainsRune(raw, '\x00') || strings.HasPrefix(raw, "/") {
		return "", fmt.Errorf("substack: unsafe ZIP entry path %q", raw)
	}
	clean := path.Clean(raw)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("substack: unsafe ZIP entry path %q", raw)
	}
	first := strings.SplitN(clean, "/", 2)[0]
	if strings.Contains(first, ":") {
		return "", fmt.Errorf("substack: unsafe ZIP entry path %q", raw)
	}
	return clean, nil
}

func extractZIPEntry(entry *zip.File, destination string) (string, int64, error) {
	r, err := entry.Open()
	if err != nil {
		return "", 0, fmt.Errorf("substack: open ZIP entry %q: %w", entry.Name, err)
	}
	defer func() { _ = r.Close() }()
	f, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", 0, fmt.Errorf("substack: create extracted entry %q: %w", entry.Name, err)
	}
	h := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, maxSubstackExportEntryBytes+1))
	closeErr := f.Close()
	if copyErr != nil {
		return "", written, fmt.Errorf("substack: extract ZIP entry %q: %w", entry.Name, copyErr)
	}
	if closeErr != nil {
		return "", written, fmt.Errorf("substack: close extracted entry %q: %w", entry.Name, closeErr)
	}
	if written > maxSubstackExportEntryBytes {
		return "", written, fmt.Errorf("substack: ZIP entry %q exceeds the extraction limit", entry.Name)
	}
	return hex.EncodeToString(h.Sum(nil)), written, nil
}

func sha256File(filePath string) (string, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return "", fmt.Errorf("substack: open file for digest: %w", err)
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", fmt.Errorf("substack: digest file: %w", err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
