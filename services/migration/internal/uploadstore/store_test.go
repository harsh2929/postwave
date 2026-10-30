package uploadstore

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReplayRestartSealAndCleanup(t *testing.T) {
	ctx := context.Background()
	s := Store{Root: t.TempDir()}
	m, err := s.Put(ctx, "tenant-a", "csv", "upload", "x.csv", 0, 6, []byte("abc"))
	if err != nil || m.Received != 3 {
		t.Fatalf("put: %v", err)
	}
	s = Store{Root: s.Root} // a new service instance has no in-memory upload state
	for _, test := range []struct {
		start   int64
		data    string
		wantErr bool
	}{{0, "abc", false}, {0, "ABC", true}, {2, "cde", true}, {4, "ef", true}} {
		m, err = s.Put(ctx, "tenant-a", "csv", "upload", "x.csv", test.start, 6, []byte(test.data))
		if test.wantErr != errors.Is(err, ErrConflict) || m.Received != 3 {
			t.Fatalf("replay offset %d: %d %v", test.start, m.Received, err)
		}
	}
	if _, err = s.Status(ctx, "tenant-b", "csv", "upload"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cross-tenant status: %v", err)
	}
	if _, err = s.Complete(ctx, "tenant-a", "csv", "upload", func(Metadata, string) error { return nil }); !errors.Is(err, ErrConflict) {
		t.Fatal("incomplete upload sealed")
	}
	if _, err = s.Put(ctx, "tenant-a", "csv", "upload", "x.csv", 3, 6, []byte("def")); err != nil {
		t.Fatal(err)
	}
	firstID := ""
	_, err = s.Complete(ctx, "tenant-a", "csv", "upload", func(m Metadata, path string) error {
		firstID = m.JobID
		b, e := os.ReadFile(path)
		if e != nil || string(b) != "abcdef" {
			t.Fatal("payload mismatch")
		}
		return errors.New("simulated lost completion response")
	})
	if err == nil || firstID == "" {
		t.Fatal("fault injection failed")
	}
	m, err = s.Complete(ctx, "tenant-a", "csv", "upload", func(m Metadata, path string) error {
		if m.JobID != firstID {
			t.Fatal("retry created a different job")
		}
		return nil
	})
	if err != nil || !m.Completed {
		t.Fatalf("complete retry: %v", err)
	}
	if _, err = s.Complete(ctx, "tenant-a", "csv", "upload", func(Metadata, string) error { t.Fatal("completed callback repeated"); return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Put(ctx, "tenant-a", "csv", "upload", "x.csv", 0, 6, []byte("abc")); !errors.Is(err, ErrConflict) {
		t.Fatal("sealed upload modified")
	}
	if err = s.Delete(ctx, "tenant-a", "csv", "upload"); err != nil {
		t.Fatal(err)
	}
	if err = s.Delete(ctx, "tenant-a", "csv", "upload"); err != nil {
		t.Fatal("cleanup is not idempotent", err)
	}
	if _, err = s.Status(ctx, "tenant-a", "csv", "upload"); !errors.Is(err, ErrDeleted) {
		t.Fatal("cleaned upload visible")
	}
	if _, err = s.Put(ctx, "tenant-a", "csv", "upload", "x.csv", 0, 6, []byte("abc")); !errors.Is(err, ErrDeleted) {
		t.Fatal("cleaned upload resurrected")
	}
	dir, _ := s.Dir("tenant-a", "csv", "upload")
	if _, err = os.Stat(filepath.Join(dir, "payload")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("raw payload retained")
	}
}

func TestConcurrentProcessesCannotReplaceAcknowledgedBytes(t *testing.T) {
	root := t.TempDir()
	commands := []*exec.Cmd{}
	for _, data := range []string{"first", "other"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestUploadStoreChildProcess$")
		cmd.Env = append(os.Environ(), "POSTWAVE_UPLOAD_TEST_CHILD="+root, "POSTWAVE_UPLOAD_TEST_BYTES="+data)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		commands = append(commands, cmd)
	}
	winners := 0
	for _, cmd := range commands {
		err := cmd.Wait()
		if err == nil {
			winners++
		} else {
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 3 {
				t.Fatal(err)
			}
		}
	}
	if winners != 1 {
		t.Fatalf("concurrent winners=%d", winners)
	}
	s := Store{Root: root}
	m, err := s.Status(context.Background(), "tenant", "csv", "shared")
	if err != nil || m.Received != 5 {
		t.Fatal("acknowledged offset lost", err)
	}
}

func TestUploadStoreChildProcess(t *testing.T) {
	root := os.Getenv("POSTWAVE_UPLOAD_TEST_CHILD")
	if root == "" {
		return
	}
	_, err := (Store{Root: root}).Put(context.Background(), "tenant", "csv", "shared", "x.csv", 0, 5, []byte(os.Getenv("POSTWAVE_UPLOAD_TEST_BYTES")))
	if errors.Is(err, ErrConflict) {
		os.Exit(3)
	}
	if err != nil {
		os.Exit(4)
	}
	os.Exit(0)
}

func TestCorruptionAndUncommittedTailNeverAdvanceOffset(t *testing.T) {
	s := Store{Root: t.TempDir()}
	ctx := context.Background()
	dir, _ := s.Dir("tenant", "csv", "upload")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	// A first chunk reached disk but no metadata was acknowledged before death.
	if err := os.WriteFile(filepath.Join(dir, "payload"), []byte(strings.Repeat("old", 10)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, "tenant", "csv", "upload", "x.csv", 0, 3, []byte("new")); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "payload"))
	if err != nil || string(b) != "new" {
		t.Fatal("uncommitted tail kept")
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(`{"received":999}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, "tenant", "csv", "upload", "x.csv", 0, 3, []byte("bad")); !errors.Is(err, ErrCorrupt) {
		t.Fatal("corrupt metadata replaced")
	}
	b, _ = os.ReadFile(filepath.Join(dir, "payload"))
	if string(b) != "new" {
		t.Fatal("acknowledged bytes replaced")
	}
	a, _ := s.Dir("tenant-a", "csv", "upload")
	bdir, _ := s.Dir("tenant_a", "csv", "upload")
	if a == bdir {
		t.Fatal("tenant sanitization collision")
	}
	for _, id := range []string{"../escape", ".", "a/b", ""} {
		if _, err := s.Dir("tenant", "csv", id); err == nil {
			t.Fatal("unsafe component accepted")
		}
	}
}

func TestUnacknowledgedFirstWriteHasRecoverableMetadata(t *testing.T) {
	s := Store{Root: t.TempDir()}
	ctx := context.Background()
	dir, err := s.Dir("tenant", "csv", "first-write")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	m := Metadata{TenantID: "tenant", Source: "csv", UploadID: "first-write", Filename: "x.csv", Total: 3, UpdatedAt: time.Now()}
	if err := write(dir, m); err != nil {
		t.Fatal(err)
	}
	// Crash after ownership metadata was flushed, before payload creation.
	m, err = s.Status(ctx, "tenant", "csv", "first-write")
	if err != nil || m.Received != 0 {
		t.Fatalf("resume: %+v %v", m, err)
	}
	m, err = s.Put(ctx, "tenant", "csv", "first-write", "x.csv", 0, 3, []byte("abc"))
	if err != nil || m.Received != 3 {
		t.Fatalf("retry: %+v %v", m, err)
	}
}

func TestCorruptMetadataDoesNotPreventOtherRetentionVisits(t *testing.T) {
	s := Store{Root: t.TempDir()}
	ctx := context.Background()
	if _, err := s.Put(ctx, "tenant", "csv", "valid", "x.csv", 0, 3, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	dir, _ := s.Dir("tenant", "csv", "bad")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	visited := 0
	err := s.Walk(ctx, func(m Metadata) error {
		if m.UploadID == "valid" {
			visited++
		}
		return nil
	})
	if !errors.Is(err, ErrCorrupt) || visited != 1 {
		t.Fatalf("visited=%d err=%v", visited, err)
	}
}
