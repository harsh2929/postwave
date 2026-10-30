// SPDX-License-Identifier: AGPL-3.0-only

package a11y

import "testing"

func TestAnalyze_MissingAlt(t *testing.T) {
	html := `<p><img src="/hero.jpg"></p>`
	rep := Analyze(html, "")
	if rep.Counts.Error == 0 {
		t.Fatal("expected an error finding for missing alt")
	}
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "img_missing_alt" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected img_missing_alt rule to fire")
	}
}

func TestAnalyze_AltEmptyStringIsFine(t *testing.T) {
	// Decorative image: alt="" is the WCAG-approved opt-out signal.
	html := `<p><img src="/decorative.jpg" alt=""></p>`
	rep := Analyze(html, "")
	for _, f := range rep.Findings {
		if f.Rule == "img_missing_alt" {
			t.Errorf("alt=\"\" should NOT fire missing_alt; got %+v", f)
		}
	}
}

func TestAnalyze_EmptyLink(t *testing.T) {
	rep := Analyze(`<a href="/x"></a>`, "")
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "link_empty_text" {
			found = true
		}
	}
	if !found {
		t.Error("expected link_empty_text to fire")
	}
}

func TestAnalyze_GenericLinkText(t *testing.T) {
	rep := Analyze(`<a href="/x">click here</a>`, "")
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "link_generic_text" {
			found = true
		}
	}
	if !found {
		t.Error("expected link_generic_text on 'click here'")
	}
}

func TestAnalyze_LangAttributePresent(t *testing.T) {
	rep := Analyze(`<html lang="en"><body><p>Hi</p></body></html>`, "")
	for _, f := range rep.Findings {
		if f.Rule == "html_missing_lang" {
			t.Errorf("html_missing_lang should not fire when lang=en is present")
		}
	}
}

func TestAnalyze_LangMissingFires(t *testing.T) {
	rep := Analyze(`<html><body><p>Hi</p></body></html>`, "")
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "html_missing_lang" {
			found = true
		}
	}
	if !found {
		t.Error("expected html_missing_lang when <html> has no lang")
	}
}

func TestAnalyze_LowContrast(t *testing.T) {
	// Light-gray-on-white is the classic low-contrast offender.
	html := `<p style="color: #aaaaaa; background-color: #ffffff">Hi</p>`
	rep := Analyze(html, "")
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "low_contrast" {
			found = true
		}
	}
	if !found {
		t.Error("expected low_contrast for #aaaaaa on #ffffff")
	}
}

func TestAnalyze_GoodContrast(t *testing.T) {
	// Black on white = 21:1, well above 4.5:1.
	html := `<p style="color: #000000; background-color: #ffffff">Hi</p>`
	rep := Analyze(html, "")
	for _, f := range rep.Findings {
		if f.Rule == "low_contrast" {
			t.Errorf("low_contrast fired on black-on-white: %+v", f)
		}
	}
}

func TestAnalyze_SmallFont(t *testing.T) {
	rep := Analyze(`<p style="font-size: 9px">Tiny</p>`, "")
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "font_size_too_small" {
			found = true
		}
	}
	if !found {
		t.Error("expected font_size_too_small for 9px")
	}
}

func TestAnalyze_SubjectLength(t *testing.T) {
	long := "this is a really really really long subject line that overflows the typical 70-char ceiling"
	rep := Analyze("", long)
	found := false
	for _, f := range rep.Findings {
		if f.Rule == "subject_too_long" {
			found = true
		}
	}
	if !found {
		t.Error("expected subject_too_long")
	}
}

func TestAnalyze_ScoreMath(t *testing.T) {
	// One error + one warn → 100 - 15 - 5 = 80.
	html := `<p><img src="/x.jpg"></p><a href="/y">click here</a>`
	rep := Analyze(html, "")
	if rep.Score < 70 || rep.Score > 85 {
		t.Errorf("expected score in [70,85], got %d", rep.Score)
	}
}

func TestAnalyze_PerfectScore(t *testing.T) {
	rep := Analyze(``, "")
	if rep.Score != 100 {
		t.Errorf("empty html should score 100, got %d", rep.Score)
	}
}
