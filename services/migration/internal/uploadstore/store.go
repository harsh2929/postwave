// Package uploadstore keeps migration files on a shared POSIX filesystem.
// All writers take the same NFS-compatible lock, flush data before publishing
// offsets, and atomically replace metadata. A sealed upload is immutable.
package uploadstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sys/unix"
)

const MaxBytes int64 = 200 << 20
const MaxChunkBytes int64 = 16 << 20

var ErrConflict = errors.New("upload state conflicts with this request")
var ErrCorrupt = errors.New("upload metadata or payload is inconsistent")
var ErrDeleted = errors.New("upload has been cleaned up; start a new upload")

type Metadata struct {
	TenantID  string     `json:"tenant_id"`
	Source    string     `json:"source"`
	UploadID  string     `json:"upload_id"`
	Filename  string     `json:"filename"`
	Total     int64      `json:"total"`
	Received  int64      `json:"received"`
	UpdatedAt time.Time  `json:"updated_at"`
	Sealed    bool       `json:"sealed,omitempty"`
	SHA256    string     `json:"sha256,omitempty"`
	JobID     string     `json:"job_id,omitempty"`
	Completed bool       `json:"completed,omitempty"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
}

type Store struct{ Root string }

func component(s string) bool {
	if s == "" || len(s) > 100 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func (s Store) Dir(tenant, source, id string) (string, error) {
	if tenant == "" || !component(source) || !component(id) || !filepath.IsAbs(s.Root) {
		return "", ErrConflict
	}
	hash := sha256.Sum256([]byte(tenant))
	return filepath.Join(s.Root, hex.EncodeToString(hash[:]), source, id), nil
}

func lock(ctx context.Context, dir string, create bool) (func(), error) {
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for {
		err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return func() { _ = unix.Flock(int(f.Fd()), unix.LOCK_UN); _ = f.Close() }, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = f.Close()
			return nil, err
		}
		select {
		case <-ctx.Done():
			_ = f.Close()
			return nil, ctx.Err()
		case <-deadline.C:
			_ = f.Close()
			return nil, ErrConflict
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func readMetadata(dir, tenant, source, id string) (Metadata, error) {
	var m Metadata
	f, err := os.Open(filepath.Join(dir, "meta.json"))
	if err != nil {
		return m, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 65537))
	if err != nil {
		return m, err
	}
	if len(b) > 65536 || json.Unmarshal(b, &m) != nil {
		return m, ErrCorrupt
	}
	if m.TenantID != tenant || m.Source != source || m.UploadID != id || m.Total <= 0 || m.Total > MaxBytes || m.Received < 0 || m.Received > m.Total {
		return m, ErrCorrupt
	}
	if m.DeletedAt != nil {
		return m, ErrDeleted
	}
	if m.Sealed && (m.JobID == "" || len(m.SHA256) != 64 || m.Received != m.Total) {
		return m, ErrCorrupt
	}
	return m, nil
}

func read(dir, tenant, source, id string) (Metadata, error) {
	m, err := readMetadata(dir, tenant, source, id)
	if err != nil {
		return m, err
	}
	st, err := os.Stat(filepath.Join(dir, "payload"))
	if m.Received == 0 && errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil || !st.Mode().IsRegular() || st.Size() < m.Received || st.Size() > m.Total {
		return m, ErrCorrupt
	}
	return m, nil
}

// write publishes a complete new metadata version after its bytes reach the
// filesystem. Rename and directory sync make crash recovery all-or-nothing.
func write(dir string, m Metadata) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".meta-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = os.Rename(name, filepath.Join(dir, "meta.json")); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s Store) Put(ctx context.Context, tenant, source, id, filename string, start, total int64, data []byte) (Metadata, error) {
	if len(data) == 0 || int64(len(data)) > MaxChunkBytes || start < 0 || total <= 0 || total > MaxBytes || start > total-int64(len(data)) {
		return Metadata{}, ErrConflict
	}
	dir, err := s.Dir(tenant, source, id)
	if err != nil {
		return Metadata{}, err
	}
	release, err := lock(ctx, dir, true)
	if err != nil {
		return Metadata{}, err
	}
	defer release()
	m, err := readMetadata(dir, tenant, source, id)
	fresh := errors.Is(err, os.ErrNotExist)
	if errors.Is(err, os.ErrNotExist) {
		if start != 0 {
			return m, ErrConflict
		}
		m = Metadata{TenantID: tenant, Source: source, UploadID: id, Filename: filename, Total: total}
	} else if err != nil {
		return m, err
	}
	if m.Sealed || m.Total != total || m.Filename != filename || start > m.Received {
		return m, ErrConflict
	}
	if fresh {
		// Publish ownership and retention metadata before any subscriber bytes.
		// A crash before the first offset acknowledgement remains discoverable.
		m.UpdatedAt = time.Now().UTC()
		if err := write(dir, m); err != nil {
			return m, err
		}
	} else if m.Received > 0 {
		if _, err := read(dir, tenant, source, id); err != nil {
			return m, err
		}
	}
	f, err := os.OpenFile(filepath.Join(dir, "payload"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return m, err
	}
	defer f.Close()
	if m.Received == 0 {
		if err := f.Truncate(0); err != nil {
			return m, err
		}
	}
	if start < m.Received {
		if start+int64(len(data)) > m.Received {
			return m, ErrConflict
		}
		existing := make([]byte, len(data))
		if _, err := f.ReadAt(existing, start); err != nil {
			return m, err
		}
		if !bytes.Equal(existing, data) {
			return m, ErrConflict
		}
		return m, nil
	}
	if _, err = f.WriteAt(data, start); err != nil {
		return m, err
	}
	if err = f.Sync(); err != nil {
		return m, err
	}
	if err = f.Close(); err != nil {
		return m, err
	}
	m.Received = start + int64(len(data))
	m.UpdatedAt = time.Now().UTC()
	if err = write(dir, m); err != nil {
		return m, err
	}
	return m, nil
}

func (s Store) Status(ctx context.Context, tenant, source, id string) (Metadata, error) {
	dir, err := s.Dir(tenant, source, id)
	if err != nil {
		return Metadata{}, err
	}
	release, err := lock(ctx, dir, false)
	if err != nil {
		return Metadata{}, err
	}
	defer release()
	return read(dir, tenant, source, id)
}

func Digest(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, MaxBytes+1))
	if err != nil {
		return "", err
	}
	if n > MaxBytes {
		return "", ErrCorrupt
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Complete persists the planned job identity before creating it. A restart
// after job creation calls the idempotent finish callback with that same ID.
func (s Store) Complete(ctx context.Context, tenant, source, id string, finish func(Metadata, string) error) (Metadata, error) {
	dir, err := s.Dir(tenant, source, id)
	if err != nil {
		return Metadata{}, err
	}
	release, err := lock(ctx, dir, false)
	if err != nil {
		return Metadata{}, err
	}
	defer release()
	m, err := read(dir, tenant, source, id)
	if err != nil {
		return m, err
	}
	if m.Received != m.Total {
		return m, fmt.Errorf("upload incomplete: received %d want %d: %w", m.Received, m.Total, ErrConflict)
	}
	if m.Completed {
		return m, nil
	}
	path := filepath.Join(dir, "payload")
	digest, err := Digest(path)
	if err != nil {
		return m, err
	}
	if m.Sealed && m.SHA256 != digest {
		return m, ErrCorrupt
	}
	if !m.Sealed {
		m.Sealed = true
		m.SHA256 = digest
		m.JobID = uuid.NewSHA1(uuid.NameSpaceURL, []byte("postwave:migration-upload:"+tenant+":"+source+":"+id)).String()
		m.UpdatedAt = time.Now().UTC()
		if err := write(dir, m); err != nil {
			return m, err
		}
	}
	if err := finish(m, path); err != nil {
		return m, err
	}
	m.Completed = true
	m.UpdatedAt = time.Now().UTC()
	if err := write(dir, m); err != nil {
		return m, err
	}
	return m, nil
}

// Delete leaves a tombstone and the lock inode so the upload ID can never be
// reused to resurrect a cleaned session. It is idempotent after partial cleanup.
func (s Store) Delete(ctx context.Context, tenant, source, id string) error {
	_, err := s.deleteBefore(ctx, tenant, source, id, nil)
	return err
}

func (s Store) DeleteBefore(ctx context.Context, tenant, source, id string, before time.Time) (bool, error) {
	return s.deleteBefore(ctx, tenant, source, id, &before)
}

func (s Store) deleteBefore(ctx context.Context, tenant, source, id string, before *time.Time) (bool, error) {
	dir, err := s.Dir(tenant, source, id)
	if err != nil {
		return false, err
	}
	release, err := lock(ctx, dir, false)
	if err != nil {
		return false, err
	}
	defer release()
	m, err := readMetadata(dir, tenant, source, id)
	if err != nil && !errors.Is(err, ErrDeleted) {
		return false, err
	}
	if before != nil && m.UpdatedAt.After(*before) {
		return false, nil
	}
	if m.DeletedAt == nil {
		now := time.Now().UTC()
		m.DeletedAt = &now
		m.Filename = ""
		if err := write(dir, m); err != nil {
			return false, err
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Name() == ".lock" || entry.Name() == "meta.json" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Walk reads only small metadata records, never subscriber payloads. The
// callback reacquires the upload lock for mutations and must recheck job state.
func (s Store) Walk(ctx context.Context, visit func(Metadata) error) error {
	var firstErr error
	remember := func(err error) error {
		if firstErr == nil {
			firstErr = err
		}
		return nil
	}
	err := filepath.WalkDir(s.Root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return remember(walkErr)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() != "meta.json" {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return remember(err)
		}
		b, err := io.ReadAll(io.LimitReader(f, 65537))
		_ = f.Close()
		if err != nil {
			return remember(err)
		}
		var m Metadata
		if len(b) > 65536 || json.Unmarshal(b, &m) != nil {
			return remember(ErrCorrupt)
		}
		dir, err := s.Dir(m.TenantID, m.Source, m.UploadID)
		if err != nil || dir != filepath.Dir(path) {
			return remember(ErrCorrupt)
		}
		return remember(visit(m))
	})
	if err != nil {
		return err
	}
	return firstErr
}

func (s Store) Validate() error {
	if !filepath.IsAbs(s.Root) || filepath.Clean(s.Root) == "/" || strings.TrimSpace(s.Root) == "" {
		return fmt.Errorf("upload directory must be an absolute, dedicated directory")
	}
	return os.MkdirAll(s.Root, 0700)
}
