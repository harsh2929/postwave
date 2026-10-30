package archive_bar

import (
	"strings"
	"testing"
)

// ptrBool — local helper because Go has no shorthand for `*bool` literals.
func ptrBool(b bool) *bool { return &b }

func TestRender_DefaultsOn_BothTokensReplaced(t *testing.T) {
	body := `<p>Hi</p>{{ archive_bar }}<p>Body</p><a href="{{ view_in_browser_url }}">view</a>`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			TenantArchiveSlug:    "postwave-weekly",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "issue-42",
		CampaignPublic:      true,
	})
	if strings.Contains(out, "{{ archive_bar }}") {
		t.Fatalf("archive_bar token leaked: %q", out)
	}
	if !strings.Contains(out, "https://archive.moosewave.com/postwave-weekly/issue-42") {
		t.Fatalf("view_in_browser_url not substituted: %q", out)
	}
	if !strings.Contains(out, "data-postwave-archive-bar=\"1\"") {
		t.Fatalf("archive bar HTML wrapper missing: %q", out)
	}
	if !strings.Contains(out, "View past issues") {
		t.Fatalf("archive index CTA missing: %q", out)
	}
}

func TestRender_TenantDefaultOff_SuppressesBar(t *testing.T) {
	body := `<p>Hi</p>{{ archive_bar }}<a href="{{ view_in_browser_url }}">v</a>`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    false,
			ViewInBrowserEnabled: false,
			TenantArchiveSlug:    "x",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "y",
		CampaignPublic:      true,
	})
	if strings.Contains(out, "data-postwave-archive-bar") {
		t.Fatalf("bar should be suppressed when default off: %q", out)
	}
	if strings.Contains(out, "archive.moosewave.com/x/y") {
		t.Fatalf("view_in_browser should be suppressed: %q", out)
	}
}

func TestRender_CampaignOverrideBeatsTenantDefault(t *testing.T) {
	body := `{{ archive_bar }}`
	// Tenant default ON, campaign override OFF -> suppressed.
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled: true,
			TenantArchiveSlug: "p",
		},
		PublicBaseURL:              "https://archive.moosewave.com",
		CampaignArchiveSlug:        "i",
		CampaignPublic:             true,
		CampaignArchiveBarOverride: ptrBool(false),
	})
	if strings.Contains(out, "data-postwave-archive-bar") {
		t.Fatalf("campaign override=false should suppress bar: %q", out)
	}
	// Tenant default OFF, campaign override ON -> rendered.
	out = Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled: false,
			TenantArchiveSlug: "p",
		},
		PublicBaseURL:              "https://archive.moosewave.com",
		CampaignArchiveSlug:        "i",
		CampaignPublic:             true,
		CampaignArchiveBarOverride: ptrBool(true),
	})
	if !strings.Contains(out, "data-postwave-archive-bar") {
		t.Fatalf("campaign override=true should force bar: %q", out)
	}
}

func TestRender_CampaignNotPublic_SuppressesViewInBrowser(t *testing.T) {
	body := `<a href="{{ view_in_browser_url }}">view</a>`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ViewInBrowserEnabled: true,
			TenantArchiveSlug:    "p",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "i",
		CampaignPublic:      false, // not published -> link suppressed
	})
	if strings.Contains(out, "archive.moosewave.com/p/i") {
		t.Fatalf("unpublished campaign should suppress view-in-browser url: %q", out)
	}
}

func TestRender_NoSlug_NoArchiveURL(t *testing.T) {
	body := `{{ archive_url }} -- {{ archive_bar }}`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			// TenantArchiveSlug deliberately empty.
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "i",
		CampaignPublic:      true,
	})
	// Archive index URL token resolves to empty.
	if strings.Contains(out, "archive.moosewave.com") {
		t.Fatalf("expected no resolvable archive URL when slug is missing: %q", out)
	}
	// Bar HTML should be suppressed because neither URL resolves.
	if strings.Contains(out, "data-postwave-archive-bar") {
		t.Fatalf("bar should not render with no resolvable URLs: %q", out)
	}
}

func TestRender_CustomBarText(t *testing.T) {
	body := `{{ archive_bar }}`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			ArchiveBarText:       "Ver este correo en el navegador",
			TenantArchiveSlug:    "p",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "i",
		CampaignPublic:      true,
	})
	if !strings.Contains(out, "Ver este correo en el navegador") {
		t.Fatalf("custom bar text not honored: %q", out)
	}
}

func TestRender_HTMLEscapesCustomText(t *testing.T) {
	body := `{{ archive_bar }}`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			ArchiveBarText:       `<script>alert(1)</script>`,
			TenantArchiveSlug:    "p",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "i",
		CampaignPublic:      true,
	})
	if strings.Contains(out, "<script>alert(1)") {
		t.Fatalf("raw script tag escaped from operator-supplied text: %q", out)
	}
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("expected HTML escape of custom bar text: %q", out)
	}
}

func TestRender_EmptyBody(t *testing.T) {
	if got := Render("", RenderInputs{}); got != "" {
		t.Fatalf("empty input should produce empty output: %q", got)
	}
}

func TestRender_NoSpaceVariantsAlsoReplaced(t *testing.T) {
	body := `{{archive_bar}} {{view_in_browser_url}} {{archive_url}}`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			TenantArchiveSlug:    "p",
		},
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "i",
		CampaignPublic:      true,
	})
	if strings.Contains(out, "{{archive_bar}}") || strings.Contains(out, "{{view_in_browser_url}}") || strings.Contains(out, "{{archive_url}}") {
		t.Fatalf("tight-brace variants not replaced: %q", out)
	}
}

func TestResolveCampaignOverrides(t *testing.T) {
	a, v := ResolveCampaignOverrides(map[string]any{
		"archive_bar_enabled":     false,
		"view_in_browser_enabled": true,
		"unrelated":               "x",
	})
	if a == nil || *a != false {
		t.Fatalf("archive_bar_enabled override wrong: %v", a)
	}
	if v == nil || *v != true {
		t.Fatalf("view_in_browser_enabled override wrong: %v", v)
	}
	a2, v2 := ResolveCampaignOverrides(nil)
	if a2 != nil || v2 != nil {
		t.Fatalf("nil delivery_settings should yield nil overrides")
	}
	// Non-bool values silently ignored.
	a3, v3 := ResolveCampaignOverrides(map[string]any{
		"archive_bar_enabled":     "true", // string, not bool
		"view_in_browser_enabled": 1,      // number, not bool
	})
	if a3 != nil || v3 != nil {
		t.Fatalf("non-bool values should be ignored, got %v / %v", a3, v3)
	}
}

func TestHasArchiveBarToken(t *testing.T) {
	cases := map[string]bool{
		"":                                    false,
		"<p>no tokens</p>":                    false,
		"{{ archive_bar }}":                   true,
		"{{archive_bar}}":                     true,
		"text {{ view_in_browser_url }} more": true,
		"text {{view_in_browser_url}} more":   true,
		"{{ archive_url }}":                   true,
		"{{archive_url}}":                     true,
	}
	for body, want := range cases {
		if got := HasArchiveBarToken(body); got != want {
			t.Errorf("HasArchiveBarToken(%q) = %v, want %v", body, got, want)
		}
	}
}

func TestDefaultScaffoldFooter_ContainsTokens(t *testing.T) {
	if !strings.Contains(DefaultScaffoldFooter, "{{ archive_bar }}") {
		t.Fatalf("scaffold footer must carry archive_bar token: %q", DefaultScaffoldFooter)
	}
	if !strings.Contains(DefaultScaffoldFooter, "{{ view_in_browser_url }}") {
		t.Fatalf("scaffold footer must carry view_in_browser_url token: %q", DefaultScaffoldFooter)
	}
	if !strings.Contains(DefaultScaffoldFooter, "{{ unsubscribe_url }}") {
		t.Fatalf("scaffold footer must keep the existing unsubscribe token: %q", DefaultScaffoldFooter)
	}
}

func TestRender_CustomArchiveDomain(t *testing.T) {
	body := `<a href="{{ view_in_browser_url }}">v</a> {{ archive_url }}`
	out := Render(body, RenderInputs{
		Defaults: TenantDefaults{
			ArchiveBarEnabled:    true,
			ViewInBrowserEnabled: true,
			TenantArchiveSlug:    "publication",
			ArchiveDomain:        "letters.example.com",
		},
		// PublicBaseURL ignored when ArchiveDomain is set.
		PublicBaseURL:       "https://archive.moosewave.com",
		CampaignArchiveSlug: "issue-1",
		CampaignPublic:      true,
	})
	if !strings.Contains(out, "https://letters.example.com/publication/issue-1") {
		t.Fatalf("custom archive_domain not honored: %q", out)
	}
	if strings.Contains(out, "archive.moosewave.com") {
		t.Fatalf("platform host leaked when archive_domain is set: %q", out)
	}
}
