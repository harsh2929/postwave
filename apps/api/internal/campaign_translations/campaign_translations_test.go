// SPDX-License-Identifier: AGPL-3.0-only

package campaign_translations

import "testing"

func TestNormalizeLocale(t *testing.T) {
	cases := map[string]string{
		"es":     "es",
		"ES":     "es",
		"es-mx":  "es-MX",
		"ES-MX":  "es-MX",
		"fr-ca":  "fr-CA",
		"  en  ": "en",
		"pt-br":  "pt-BR",
		"":       "",
	}
	for in, want := range cases {
		if got := normalizeLocale(in); got != want {
			t.Errorf("normalizeLocale(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveForLocale(t *testing.T) {
	trs := []Translation{
		{Locale: "es", Subject: "Hola", BodyHTML: "<p>es</p>"},
		{Locale: "fr-CA", Subject: "Bonjour", BodyHTML: "<p>frca</p>"},
	}
	t.Run("exact match", func(t *testing.T) {
		s, b, ok := ResolveForLocale(trs, "es", "def", "<p>def</p>")
		if !ok || s != "Hola" || b != "<p>es</p>" {
			t.Fatalf("got %q/%q/%v", s, b, ok)
		}
	})
	t.Run("region-specific exact", func(t *testing.T) {
		s, _, ok := ResolveForLocale(trs, "fr-CA", "def", "d")
		if !ok || s != "Bonjour" {
			t.Fatalf("got %q/%v", s, ok)
		}
	})
	t.Run("language fallback es-MX -> es", func(t *testing.T) {
		s, _, ok := ResolveForLocale(trs, "es-MX", "def", "d")
		if !ok || s != "Hola" {
			t.Fatalf("got %q/%v", s, ok)
		}
	})
	t.Run("no match -> default", func(t *testing.T) {
		s, b, ok := ResolveForLocale(trs, "de", "def", "<p>def</p>")
		if ok || s != "def" || b != "<p>def</p>" {
			t.Fatalf("got %q/%q/%v", s, b, ok)
		}
	})
	t.Run("empty locale -> default", func(t *testing.T) {
		_, _, ok := ResolveForLocale(trs, "", "def", "d")
		if ok {
			t.Fatalf("empty locale should not match")
		}
	})
	t.Run("blank variant fields fall back to default", func(t *testing.T) {
		blanks := []Translation{{Locale: "it", Subject: "", BodyHTML: ""}}
		s, b, ok := ResolveForLocale(blanks, "it", "def", "<p>def</p>")
		if !ok || s != "def" || b != "<p>def</p>" {
			t.Fatalf("got %q/%q/%v", s, b, ok)
		}
	})
}

func TestValidLocale(t *testing.T) {
	valid := []string{"es", "en", "fr-CA", "pt-BR", "zh-Hans"}
	invalid := []string{"", "x", "english!", "e", "es_MX", "toolonglanguagecode"}
	for _, v := range valid {
		if !validLocale(v) {
			t.Errorf("validLocale(%q) = false, want true", v)
		}
	}
	for _, v := range invalid {
		if validLocale(v) {
			t.Errorf("validLocale(%q) = true, want false", v)
		}
	}
}
