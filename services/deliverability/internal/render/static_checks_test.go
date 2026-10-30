package render

import (
	"strings"
	"testing"
)

func TestStaticChecks_Outlook2019(t *testing.T) {
	html := `<html><head><style>@media (max-width:600px){.x{display:none;}}</style></head>
<body style="background-image:url(bg.png);position:absolute;border-radius:4px;">
<div style="display:flex;">a</div>
<svg width="20" height="20"></svg>
</body></html>`
	env, _ := LookupEnvironment("outlook_2019_desktop")
	issues := RunStaticChecks(env, html)
	wantSubstrs := []string{"position:absolute", "flexbox", "SVG", "border-radius", "@media", "background-image"}
	for _, w := range wantSubstrs {
		found := false
		for _, i := range issues {
			if strings.Contains(strings.ToLower(i), strings.ToLower(w)) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected outlook 2019 to flag %q; issues=%v", w, issues)
		}
	}
}

func TestStaticChecks_AppleDark(t *testing.T) {
	html := `<html><body style="background-color:#ffffff;color:#000;"><img src="logo.png"/></body></html>`
	env, _ := LookupEnvironment("apple_mail_macos_dark")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected dark-mode issues for white background + no color-scheme")
	}
	joined := strings.Join(issues, "|")
	if !strings.Contains(strings.ToLower(joined), "dark-mode") {
		t.Errorf("expected dark-mode review warning, got %v", issues)
	}
	if !strings.Contains(strings.ToLower(joined), "color-scheme") {
		t.Errorf("expected color-scheme warning, got %v", issues)
	}
}

func TestStaticChecks_GmailPromotions_ImageHeavy(t *testing.T) {
	// 12 images, very little text → image-heavy.
	html := "<html><body>" + strings.Repeat(`<img src="x.png"/>`, 12) + "hi</body></html>"
	env, _ := LookupEnvironment("gmail_web_promotions")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected promotions issue for image-heavy body")
	}
	joined := strings.ToLower(strings.Join(issues, "|"))
	if !strings.Contains(joined, "image-heavy body") {
		t.Errorf("expected image-heavy advisory, got %v", issues)
	}
}

func TestStaticChecks_GmailPromotions_TriggerWords(t *testing.T) {
	html := `<html><body>FREE deal — limited time sale, 50% off discount! Buy now and save big with this exclusive offer.</body></html>`
	env, _ := LookupEnvironment("gmail_web_promotions")
	issues := RunStaticChecks(env, html)
	joined := strings.ToLower(strings.Join(issues, "|"))
	if !strings.Contains(joined, "promotional phrases") {
		t.Errorf("expected promotional-language advisory, got %v", issues)
	}
}

func TestStaticChecks_GmailCannotInferHeadersOrPlacementFromBody(t *testing.T) {
	env, _ := LookupEnvironment("gmail_web_promotions")
	issues := RunStaticChecks(env, `<html><body><p>A useful update.</p></body></html>`)
	if len(issues) != 0 {
		t.Fatalf("ordinary body must not imply missing MIME headers or placement: %v", issues)
	}
}

func TestStaticChecks_Yahoo_FlexGrid(t *testing.T) {
	html := `<div style="display:flex;">x</div>`
	env, _ := LookupEnvironment("yahoo_web")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected yahoo to flag flex")
	}
}

func TestStaticChecks_Proton_RemoteImages(t *testing.T) {
	html := `<img src="https://cdn.example.com/logo.png"/>`
	env, _ := LookupEnvironment("proton_mail_web")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected proton to flag remote images")
	}
}

func TestStaticChecks_AppleMail_Fonts(t *testing.T) {
	html := `<style>@font-face { font-family: "Custom"; src: url(c.woff2); }</style><body>x</body>`
	env, _ := LookupEnvironment("apple_mail_macos_light")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected apple mail light to flag @font-face")
	}
}

func TestStaticChecks_OutlookMac_MediaQuery(t *testing.T) {
	html := `<style>@media (max-width:600px){.x{display:none;}}</style>`
	env, _ := LookupEnvironment("outlook_macos")
	issues := RunStaticChecks(env, html)
	if len(issues) == 0 {
		t.Fatal("expected outlook macOS to flag @media")
	}
}

func TestStaticChecks_Clean(t *testing.T) {
	// A reasonably clean HTML for outlook-365-web should produce no issues.
	html := `<html><body><p>Hello</p></body></html>`
	env, _ := LookupEnvironment("outlook_365_web")
	issues := RunStaticChecks(env, html)
	if len(issues) != 0 {
		t.Errorf("expected no issues, got %v", issues)
	}
}
