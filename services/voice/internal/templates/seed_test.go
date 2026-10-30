package templates

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSeededMemoryStore_LoadsAllTemplates(t *testing.T) {
	store, err := SeededMemoryStore()
	if err != nil {
		t.Fatalf("SeededMemoryStore: %v", err)
	}
	all, err := store.List(context.Background(), "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got, want := len(all), 1; got != want {
		t.Fatalf("template count = %d, want %d", got, want)
	}
}

func TestSeededMemoryStore_CategoryDistribution(t *testing.T) {
	store, err := SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	expected := map[TemplateCategory]int{CategoryWelcome: 1, CategoryNewsletterSeries: 0, CategoryProductLaunch: 0}

	for cat, want := range expected {
		got, err := store.List(context.Background(), cat)
		if err != nil {
			t.Fatalf("List(%s): %v", cat, err)
		}
		if len(got) != want {
			t.Errorf("category %s: got %d templates, want %d", cat, len(got), want)
		}
	}
}

func TestSeededMemoryStore_AllTemplatesHaveRequiredFields(t *testing.T) {
	store, err := SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	all, err := store.List(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, tmpl := range all {
		if tmpl.Slug == "" {
			t.Errorf("template %q missing slug", tmpl.Name)
		}
		if tmpl.Name == "" {
			t.Errorf("template %s missing name", tmpl.Slug)
		}
		if tmpl.Description == "" {
			t.Errorf("template %s missing description", tmpl.Slug)
		}
		if tmpl.Category == "" {
			t.Errorf("template %s missing category", tmpl.Slug)
		}
		if tmpl.Length != len(tmpl.Emails) {
			t.Errorf("template %s: Length=%d, len(Emails)=%d", tmpl.Slug, tmpl.Length, len(tmpl.Emails))
		}
		if len(tmpl.Emails) == 0 {
			t.Errorf("template %s has no emails", tmpl.Slug)
		}
		// Each email has subject + body + position monotonic from 1.
		for i, em := range tmpl.Emails {
			if em.Position != i+1 {
				t.Errorf("template %s email[%d]: position=%d, want %d", tmpl.Slug, i, em.Position, i+1)
			}
			if strings.TrimSpace(em.SubjectSkeleton) == "" {
				t.Errorf("template %s email[%d]: empty subject", tmpl.Slug, i)
			}
			if len(em.BodySkeleton) < 100 {
				t.Errorf("template %s email[%d]: body too short (%d chars)", tmpl.Slug, i, len(em.BodySkeleton))
			}
			if strings.TrimSpace(em.Notes) == "" {
				t.Errorf("template %s email[%d]: empty notes", tmpl.Slug, i)
			}
		}
	}
}

func TestMemoryStore_GetBySlugAndID(t *testing.T) {
	store, err := SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	bySlug, err := store.Get(context.Background(), "public-welcome-example")
	if err != nil {
		t.Fatal(err)
	}
	byID, err := store.Get(context.Background(), bySlug.ID)
	if err != nil {
		t.Fatal(err)
	}
	if byID.Slug != bySlug.Slug {
		t.Fatalf("Get by ID and slug returned different templates")
	}
}

func TestReadTemplateFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "oversized.json")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	if err := f.Truncate(maxVoiceTemplateFileBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate template: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close template: %v", err)
	}

	_, err = readTemplateFile(path)
	if err == nil || !strings.Contains(err.Error(), "template file exceeds") {
		t.Fatalf("expected oversized template error, got %v", err)
	}
}

func TestPublicRuntimeStubPackLoads(t *testing.T) {
	t.Setenv("VOICE_TEMPLATES_PATH", filepath.Join("..", "..", "..", "..", "proprietary-stubs", "templates", "voice-templates"))
	store, err := SeededMemoryStore()
	if err != nil {
		t.Fatal(err)
	}
	all, err := store.List(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || all[0].Slug != "public-welcome-example" || len(all[0].Emails) != 3 {
		t.Fatalf("public runtime pack must load the redistributable three-email example")
	}
}
