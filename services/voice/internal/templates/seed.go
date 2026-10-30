package templates

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

//go:embed embedded/*.json
var embeddedTemplates embed.FS

const maxVoiceTemplateFileBytes int64 = 512 << 10

// SeededMemoryStore returns a MemoryStore preloaded with the voice template
// library. Templates are loaded from VOICE_TEMPLATES_PATH when set, otherwise
// from the package's embedded starter library.
func SeededMemoryStore() (*MemoryStore, error) {
	store := NewMemoryStore()
	if err := SeedInto(context.Background(), store); err != nil {
		return nil, err
	}
	return store, nil
}

// SeedInto loads every template JSON from the configured path into store.
// Templates load in lexicographic filename order so List output is
// deterministic.
func SeedInto(ctx context.Context, store TemplateStore) error {
	dir := os.Getenv("VOICE_TEMPLATES_PATH")
	if dir != "" {
		return seedFromDir(ctx, store, dir)
	}
	return seedFromFS(ctx, store, embeddedTemplates, "embedded")
}

func seedFromDir(ctx context.Context, store TemplateStore, dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("templates: read dir %s: %w", dir, err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		raw, err := readTemplateFile(filepath.Join(dir, name))
		if err != nil {
			return fmt.Errorf("templates: read %s: %w", name, err)
		}
		var t Template
		if err := json.Unmarshal(raw, &t); err != nil {
			return fmt.Errorf("templates: decode %s: %w", name, err)
		}
		if err := seedOne(ctx, store, t, name); err != nil {
			return err
		}
	}
	return nil
}

func readTemplateFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	b, err := io.ReadAll(io.LimitReader(f, maxVoiceTemplateFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxVoiceTemplateFileBytes {
		return nil, fmt.Errorf("template file exceeds %d bytes", maxVoiceTemplateFileBytes)
	}
	return b, nil
}

func seedFromFS(ctx context.Context, store TemplateStore, source fs.FS, dir string) error {
	entries, err := fs.ReadDir(source, dir)
	if err != nil {
		return fmt.Errorf("templates: read embedded library: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if len(names) == 0 {
		return fmt.Errorf("templates: embedded library is empty")
	}
	for _, name := range names {
		raw, err := fs.ReadFile(source, filepath.ToSlash(filepath.Join(dir, name)))
		if err != nil {
			return fmt.Errorf("templates: read embedded %s: %w", name, err)
		}
		var t Template
		if err := json.Unmarshal(raw, &t); err != nil {
			return fmt.Errorf("templates: decode embedded %s: %w", name, err)
		}
		if err := seedOne(ctx, store, t, name); err != nil {
			return err
		}
	}
	return nil
}

func seedOne(ctx context.Context, store TemplateStore, t Template, name string) error {
	if strings.TrimSpace(t.Slug) == "" {
		return fmt.Errorf("templates: %s missing slug", name)
	}
	if t.Length == 0 {
		t.Length = len(t.Emails)
	}
	existing, err := store.Get(ctx, t.Slug)
	if err == nil {
		t.ID = existing.ID
		if t.CreatedAt.IsZero() {
			t.CreatedAt = existing.CreatedAt
		}
		if _, err := store.Update(ctx, t); err != nil {
			return fmt.Errorf("templates: update %s: %w", name, err)
		}
		return nil
	}
	if !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("templates: lookup %s: %w", name, err)
	}
	if _, err := store.Create(ctx, t); err != nil {
		return fmt.Errorf("templates: create %s: %w", name, err)
	}
	return nil
}
