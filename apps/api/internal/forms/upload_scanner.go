// SPDX-License-Identifier: AGPL-3.0-only

package forms

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// UploadObjectReader opens the private quarantine object. Implementations
// must never return a public URL: clean/infected is decided only after the
// worker consumes this stream.
type UploadObjectReader interface {
	Open(ctx context.Context, key string) (io.ReadCloser, error)
}

type ScanVerdict string

const (
	ScanClean    ScanVerdict = "clean"
	ScanInfected ScanVerdict = "infected"
)

// MalwareScanner is deliberately provider-neutral. Production currently
// wires ClamAV; another managed scanner can implement the same fail-closed
// stream contract without changing upload or database code.
type MalwareScanner interface {
	Ping(ctx context.Context) error
	Scan(ctx context.Context, body io.Reader) (verdict ScanVerdict, bytesRead int64, detail string, err error)
}

// ClamAVScanner implements clamd's documented zero-terminated INSTREAM
// protocol. The address is an internal TCP endpoint (normally port 3310) or a
// unix socket prefixed with unix://. No public network fallback exists.
type ClamAVScanner struct {
	Network string
	Address string
	Timeout time.Duration
}

func NewClamAVScanner(address string) (*ClamAVScanner, error) {
	address = strings.TrimSpace(address)
	if address == "" {
		return nil, errors.New("forms scanner: ClamAV address is empty")
	}
	network := "tcp"
	if strings.HasPrefix(address, "unix://") {
		network = "unix"
		address = strings.TrimPrefix(address, "unix://")
	}
	if address == "" {
		return nil, errors.New("forms scanner: ClamAV address is empty")
	}
	return &ClamAVScanner{Network: network, Address: address, Timeout: 30 * time.Second}, nil
}

func (s *ClamAVScanner) dial(ctx context.Context) (net.Conn, error) {
	if s == nil || strings.TrimSpace(s.Address) == "" {
		return nil, errors.New("forms scanner: ClamAV is not configured")
	}
	timeout := s.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, s.Network, s.Address)
	if err != nil {
		return nil, fmt.Errorf("forms scanner: connect to ClamAV: %w", err)
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	return conn, nil
}

func (s *ClamAVScanner) Ping(ctx context.Context) error {
	conn, connectionErr := s.dial(ctx)
	if connectionErr != nil {
		return connectionErr
	}
	defer func() { _ = conn.Close() }()
	if _, err := io.WriteString(conn, "zPING\x00"); err != nil {
		return fmt.Errorf("forms scanner: ClamAV ping write: %w", err)
	}
	reply, connectionErr := readClamReply(conn)
	if connectionErr != nil {
		return fmt.Errorf("forms scanner: ClamAV ping read: %w", connectionErr)
	}
	if strings.TrimSpace(reply) != "PONG" {
		return fmt.Errorf("forms scanner: unexpected ClamAV ping response %q", reply)
	}
	return nil
}

func (s *ClamAVScanner) Scan(ctx context.Context, body io.Reader) (ScanVerdict, int64, string, error) {
	conn, connectionErr := s.dial(ctx)
	if connectionErr != nil {
		return "", 0, "", connectionErr
	}
	defer func() { _ = conn.Close() }()
	if _, err := io.WriteString(conn, "zINSTREAM\x00"); err != nil {
		return "", 0, "", fmt.Errorf("forms scanner: ClamAV command: %w", err)
	}
	buf := make([]byte, 32<<10)
	var total int64
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			var size [4]byte
			// n is bounded by the fixed 32 KiB buffer above.
			binary.BigEndian.PutUint32(size[:], uint32(n)) // #nosec G115 -- n <= len(buf) == 32 KiB
			if err := writeClamBytes(conn, size[:]); err != nil {
				return "", total, "", fmt.Errorf("forms scanner: ClamAV chunk header: %w", err)
			}
			if err := writeClamBytes(conn, buf[:n]); err != nil {
				return "", total, "", fmt.Errorf("forms scanner: ClamAV chunk: %w", err)
			}
			total += int64(n)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return "", total, "", fmt.Errorf("forms scanner: read quarantine object: %w", readErr)
		}
	}
	if err := writeClamBytes(conn, []byte{0, 0, 0, 0}); err != nil {
		return "", total, "", fmt.Errorf("forms scanner: ClamAV terminator: %w", err)
	}
	reply, connectionErr := readClamReply(conn)
	if connectionErr != nil {
		return "", total, "", fmt.Errorf("forms scanner: ClamAV result: %w", connectionErr)
	}
	switch {
	case strings.HasSuffix(reply, " OK"):
		return ScanClean, total, "clean", nil
	case strings.HasSuffix(reply, " FOUND"):
		// Do not persist the full provider response: it can include an object
		// label. The stable word "malware" is sufficient operator evidence.
		return ScanInfected, total, "malware detected", nil
	default:
		return "", total, "", fmt.Errorf("forms scanner: unexpected ClamAV result %q", reply)
	}
}

func writeClamBytes(w io.Writer, payload []byte) error {
	for len(payload) > 0 {
		n, err := w.Write(payload)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		payload = payload[n:]
	}
	return nil
}

func readClamReply(r io.Reader) (string, error) {
	reader := bufio.NewReader(io.LimitReader(r, 4096))
	reply, err := reader.ReadString(0)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	reply = strings.TrimSpace(strings.TrimSuffix(reply, "\x00"))
	if reply == "" {
		return "", errors.New("empty ClamAV response")
	}
	return reply, nil
}

type quarantinedUpload struct {
	ID          string
	TenantID    string
	StorageKey  string
	MIME        string
	Size        int64
	Attempts    int
	ScanClaimed time.Time
}

// ScanQuarantined processes a bounded batch. Objects never become available
// merely because the scanner errored: transient failures stay quarantined;
// exhausted failures become error, which is also a terminal deny state.
func (u *Uploads) ScanQuarantined(ctx context.Context, limit int) (int, error) {
	if u == nil || u.Pool == nil || u.Store == nil || u.ObjectReader == nil || u.Scanner == nil {
		return 0, errors.New("forms: upload scanner dependencies are incomplete")
	}
	if limit <= 0 {
		limit = 25
	}
	if limit > 250 {
		limit = 250
	}
	var errs []error
	if err := u.cleanupUnsafeObjects(ctx, limit); err != nil {
		errs = append(errs, err)
	}
	claimed, err := u.claimQuarantined(ctx, limit)
	if err != nil {
		return 0, errors.Join(append(errs, err)...)
	}
	for _, upload := range claimed {
		if err := u.scanOne(ctx, upload); err != nil {
			errs = append(errs, err)
		}
	}
	if err := u.cleanupUnsafeObjects(ctx, limit); err != nil {
		errs = append(errs, err)
	}
	return len(claimed), errors.Join(errs...)
}

func (u *Uploads) claimQuarantined(ctx context.Context, limit int) ([]quarantinedUpload, error) {
	tx, err := db.WithWorkerScope(ctx, u.Pool)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM form_file_uploads
     WHERE submission_id IS NOT NULL
       AND scan_status IN ('pending', 'quarantined')
       AND scan_next_attempt_at <= now()
       AND (scan_claimed_at IS NULL OR scan_claimed_at < now() - INTERVAL '10 minutes')
     ORDER BY scan_next_attempt_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $1
)
UPDATE form_file_uploads AS upload
   SET scan_claimed_at = now(), scan_attempts = scan_attempts + 1
  FROM candidates
 WHERE upload.id = candidates.id
RETURNING upload.id::text, upload.tenant_id::text, upload.storage_key,
          upload.mime_type, upload.size_bytes, upload.scan_attempts,
          upload.scan_claimed_at`, limit)
	if err != nil {
		return nil, fmt.Errorf("forms: claim quarantine scans: %w", err)
	}
	defer rows.Close()
	out := make([]quarantinedUpload, 0, limit)
	for rows.Next() {
		var item quarantinedUpload
		if err := rows.Scan(&item.ID, &item.TenantID, &item.StorageKey, &item.MIME, &item.Size, &item.Attempts, &item.ScanClaimed); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (u *Uploads) scanOne(ctx context.Context, upload quarantinedUpload) error {
	body, bodyErr := u.ObjectReader.Open(ctx, upload.StorageKey)
	if bodyErr != nil {
		return u.recordScanFailure(ctx, upload, "object unavailable", bodyErr)
	}
	defer func() { _ = body.Close() }()

	limited := io.LimitReader(body, upload.Size+1)
	buffered := bufio.NewReader(limited)
	peek, peekErr := buffered.Peek(512)
	if peekErr != nil && !errors.Is(peekErr, io.EOF) && !errors.Is(peekErr, bufio.ErrBufferFull) {
		return u.recordScanFailure(ctx, upload, "object read failed", peekErr)
	}
	detected := NormalizeUploadMime(http.DetectContentType(peek))
	if !uploadMIMEMatches(upload.MIME, detected) {
		if err := u.finishScan(ctx, upload, "rejected", "declared MIME does not match file content"); err != nil {
			return err
		}
		return u.deleteTerminalObject(ctx, upload)
	}
	verdict, bytesRead, detail, bodyErr := u.Scanner.Scan(ctx, buffered)
	if bodyErr != nil {
		return u.recordScanFailure(ctx, upload, "scanner unavailable", bodyErr)
	}
	if bytesRead != upload.Size {
		if err := u.finishScan(ctx, upload, "rejected", "uploaded byte count does not match reservation"); err != nil {
			return err
		}
		return u.deleteTerminalObject(ctx, upload)
	}
	status := string(verdict)
	if verdict != ScanClean && verdict != ScanInfected {
		return u.recordScanFailure(ctx, upload, "scanner returned no verdict", errors.New("invalid malware scanner verdict"))
	}
	if err := u.finishScan(ctx, upload, status, detail); err != nil {
		return err
	}
	if verdict == ScanInfected {
		return u.deleteTerminalObject(ctx, upload)
	}
	return nil
}

func (u *Uploads) cleanupUnsafeObjects(ctx context.Context, limit int) error {
	tx, err := db.WithWorkerScope(ctx, u.Pool)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH candidates AS (
    SELECT id
      FROM form_file_uploads
	WHERE scan_status IN ('infected','rejected','error')
       AND object_deleted_at IS NULL
       AND (scan_claimed_at IS NULL OR scan_claimed_at < now() - INTERVAL '10 minutes')
     ORDER BY scanned_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT $1
)
UPDATE form_file_uploads AS upload
   SET scan_claimed_at = now()
  FROM candidates
 WHERE upload.id = candidates.id
RETURNING upload.id::text, upload.tenant_id::text, upload.storage_key,
          upload.scan_claimed_at`, limit)
	if err != nil {
		return err
	}
	items := make([]quarantinedUpload, 0, limit)
	for rows.Next() {
		var item quarantinedUpload
		if err := rows.Scan(&item.ID, &item.TenantID, &item.StorageKey, &item.ScanClaimed); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	var errs []error
	for _, item := range items {
		if err := u.deleteTerminalObject(ctx, item); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (u *Uploads) deleteTerminalObject(ctx context.Context, upload quarantinedUpload) error {
	if err := u.Store.Delete(ctx, upload.StorageKey); err != nil {
		_ = u.releaseTerminalDeleteClaim(ctx, upload)
		return fmt.Errorf("forms: delete rejected upload %s: %w", upload.ID, err)
	}
	tx, err := db.WithTenant(ctx, u.Pool, upload.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE form_file_uploads
   SET object_deleted_at = now(), scan_claimed_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid
	AND scan_status IN ('infected','rejected','error')
	AND (scan_claimed_at IS NULL OR scan_claimed_at = $3)`, upload.TenantID, upload.ID, upload.ScanClaimed); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (u *Uploads) releaseTerminalDeleteClaim(ctx context.Context, upload quarantinedUpload) error {
	tx, err := db.WithTenant(ctx, u.Pool, upload.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE form_file_uploads SET scan_claimed_at = NULL
 WHERE tenant_id = $1::uuid AND id = $2::uuid
	AND scan_status IN ('infected','rejected','error')
	AND scan_claimed_at = $3`, upload.TenantID, upload.ID, upload.ScanClaimed); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func uploadMIMEMatches(declared, detected string) bool {
	declared = NormalizeUploadMime(declared)
	detected = NormalizeUploadMime(detected)
	if declared == detected {
		return true
	}
	// DetectContentType adds a charset for plain text; NormalizeUploadMime
	// removes it. Some short/empty text is reported as octet-stream and is
	// deliberately rejected rather than weakening the allowlist.
	return declared == "image/jpeg" && detected == "image/jpg"
}

func (u *Uploads) recordScanFailure(ctx context.Context, upload quarantinedUpload, detail string, cause error) error {
	status := "quarantined"
	if upload.Attempts >= 5 {
		status = "error"
	}
	if err := u.finishScan(ctx, upload, status, detail); err != nil {
		return errors.Join(cause, err)
	}
	return fmt.Errorf("forms: scan upload %s: %w", upload.ID, cause)
}

func (u *Uploads) finishScan(ctx context.Context, upload quarantinedUpload, status, detail string) error {
	tx, err := db.WithTenant(ctx, u.Pool, upload.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	nextAttempt := time.Now().UTC()
	if status == "quarantined" {
		backoff := time.Duration(1<<min(upload.Attempts, 6)) * time.Minute
		nextAttempt = nextAttempt.Add(backoff)
	}
	tag, err := tx.Exec(ctx, `
UPDATE form_file_uploads
   SET scan_status = $1,
       scan_detail = NULLIF($2, ''),
       scanned_at = CASE WHEN $1 IN ('clean','infected','rejected','error') THEN now() ELSE NULL END,
       scan_next_attempt_at = $3,
       scan_claimed_at = NULL
 WHERE tenant_id = $4::uuid
   AND id = $5::uuid
   AND scan_claimed_at = $6`, status, detail, nextAttempt, upload.TenantID, upload.ID, upload.ScanClaimed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("forms: upload scan lease was lost before verdict persistence")
	}
	return tx.Commit(ctx)
}

type UploadScanWorker struct {
	Uploads  *Uploads
	Interval time.Duration
	Batch    int
	Logger   *slog.Logger
}

func (w *UploadScanWorker) Run(ctx context.Context) {
	if w == nil || w.Uploads == nil || w.Uploads.Scanner == nil {
		return
	}
	if w.Interval <= 0 {
		w.Interval = 15 * time.Second
	}
	if w.Batch <= 0 {
		w.Batch = 25
	}
	run := func() {
		claimed, err := w.Uploads.ScanQuarantined(ctx, w.Batch)
		if err != nil && !errors.Is(err, context.Canceled) && w.Logger != nil {
			w.Logger.Warn("form upload malware scan failed", "claimed", claimed, "err", err.Error())
		}
	}
	run()
	ticker := time.NewTicker(w.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
