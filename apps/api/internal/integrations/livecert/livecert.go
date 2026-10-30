// SPDX-License-Identifier: AGPL-3.0-only

// Package livecert provides provider-agnostic tooling for native integration
// live certification. It records sanitized JSONL evidence rows as harnesses
// exercise real provider APIs, and validates that a completed evidence report
// contains every required automated and manual check before a connector may be
// promoted from RuntimePartial to RuntimeAvailable.
//
// The recorder never writes raw credential material: any evidence detail whose
// key looks like a token, secret, or password is dropped before serialization.
package livecert

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// StatusPassed is the only evidence status that counts toward completeness.
const StatusPassed = "passed"

// Evidence is a single sanitized certification check result, serialized as one
// JSON object per line in the evidence report.
type Evidence struct {
	Provider   string         `json:"provider"`
	Check      string         `json:"check"`
	Status     string         `json:"status"`
	RecordedAt string         `json:"recorded_at"`
	Details    map[string]any `json:"details,omitempty"`
}

// Recorder appends sanitized evidence rows for one provider to a JSONL report.
// When ReportPath is empty (the credential-free default) Record is a silent
// no-op, so harnesses can call it unconditionally.
type Recorder struct {
	Provider   string
	ReportPath string
	// Now defaults to time.Now when nil; injectable for deterministic tests.
	Now func() time.Time

	mu sync.Mutex
}

func (r *Recorder) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Record appends one passed evidence row for the given check. Sensitive detail
// keys are stripped before serialization.
func (r *Recorder) Record(check string, details map[string]any) error {
	if strings.TrimSpace(r.ReportPath) == "" {
		return nil
	}
	evidence := Evidence{
		Provider:   r.Provider,
		Check:      strings.TrimSpace(check),
		Status:     StatusPassed,
		RecordedAt: r.now().UTC().Format(time.RFC3339),
		Details:    SanitizeDetails(details),
	}
	raw, err := json.Marshal(evidence)
	if err != nil {
		return fmt.Errorf("marshal %s live certification evidence: %w", r.Provider, err)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if dir := filepath.Dir(r.ReportPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s live certification evidence directory: %w", r.Provider, err)
		}
	}
	f, err := os.OpenFile(r.ReportPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open %s live certification evidence report: %w", r.Provider, err)
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Write(append(raw, '\n')); err != nil {
		return fmt.Errorf("write %s live certification evidence report: %w", r.Provider, err)
	}
	return nil
}

// SanitizeDetails drops any key that looks like a token, secret, or password so
// raw credential material never reaches the on-disk evidence report. Harnesses
// should record booleans/counts ("access_token_present": true), not raw values.
func SanitizeDetails(details map[string]any) map[string]any {
	if len(details) == 0 {
		return nil
	}
	out := make(map[string]any, len(details))
	for key, value := range details {
		normalized := strings.ToLower(strings.TrimSpace(key))
		if normalized == "" || isSensitiveKey(normalized) {
			continue
		}
		out[key] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func isSensitiveKey(normalizedKey string) bool {
	for _, marker := range []string{"token", "secret", "password", "apikey", "api_key", "signature", "credential"} {
		if strings.Contains(normalizedKey, marker) {
			return true
		}
	}
	return false
}

// ReadReport parses a JSONL evidence report into its entries, skipping blank
// lines.
func ReadReport(path string) ([]Evidence, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open live certification evidence report: %w", err)
	}
	defer func() { _ = f.Close() }()

	var entries []Evidence
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry Evidence
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			return nil, fmt.Errorf("decode live certification evidence line %d: %w", lineNo, err)
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read live certification evidence report: %w", err)
	}
	return entries, nil
}

// ValidateCompleteness returns an error unless every required check is present
// for the given provider with status "passed" and a non-empty recorded_at.
// Evidence from other providers or with a non-passed status is ignored.
func ValidateCompleteness(provider string, entries []Evidence, required []string) error {
	found := map[string]Evidence{}
	for _, entry := range entries {
		if strings.TrimSpace(entry.Provider) != provider || strings.TrimSpace(entry.Status) != StatusPassed {
			continue
		}
		check := strings.TrimSpace(entry.Check)
		if check == "" {
			continue
		}
		found[check] = entry
	}

	var missing []string
	for _, check := range required {
		entry, ok := found[check]
		if !ok {
			missing = append(missing, check)
			continue
		}
		if strings.TrimSpace(entry.RecordedAt) == "" {
			return fmt.Errorf("%s live certification evidence check %q is missing recorded_at", provider, check)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s live certification evidence is missing required checks: %s", provider, strings.Join(missing, ", "))
	}
	return nil
}

// Env reads a trimmed environment variable.
func Env(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

// Bool reports whether an environment variable holds a truthy opt-in value.
func Bool(key string) bool {
	switch strings.ToLower(Env(key)) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

// CSV splits a comma/whitespace-delimited list into trimmed, de-duplicated,
// order-preserving fields.
func CSV(raw string) []string {
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\t' || r == ' '
	})
	out := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		field = strings.TrimSpace(field)
		if field == "" || seen[field] {
			continue
		}
		seen[field] = true
		out = append(out, field)
	}
	return out
}
