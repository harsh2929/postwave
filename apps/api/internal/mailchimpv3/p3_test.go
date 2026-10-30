package mailchimpv3

import (
	"strings"
	"testing"
)

func TestRenderMailchimpTemplatePreview(t *testing.T) {
	html, found, unsupported, footer := renderMailchimpTemplate(
		`Hi *|FNAME|* *|IF:VIP|*VIP*|ELSE:|*friend*|END:IF|* *|UNSUB|* *|UNKNOWN|*`,
		map[string]any{"FNAME": "Ada", "VIP": true},
	)
	if !strings.Contains(html, "Hi Ada VIP") {
		t.Fatalf("html = %s", html)
	}
	if !footer {
		t.Fatalf("expected footer detection")
	}
	if len(unsupported) != 1 || unsupported[0] != "UNKNOWN" {
		t.Fatalf("unsupported = %v", unsupported)
	}
	if strings.Join(found, ",") != "FNAME,UNKNOWN,UNSUB" {
		t.Fatalf("found = %v", found)
	}
}

func TestRenderMailchimpTemplateElseIfAndComparisons(t *testing.T) {
	html, _, unsupported, _ := renderMailchimpTemplate(
		`*|IF:TRANSACTIONS >= 20|*40*|ELSEIF:TRANSACTIONS >= 10|*20*|ELSE:|*10*|END:IF|*`,
		map[string]any{"TRANSACTIONS": 12},
	)
	if strings.TrimSpace(html) != "20" {
		t.Fatalf("html = %q", html)
	}
	if len(unsupported) != 0 {
		t.Fatalf("unsupported = %v", unsupported)
	}
}

func TestRenderMailchimpTemplateInterestCondition(t *testing.T) {
	html, _, unsupported, _ := renderMailchimpTemplate(
		`*|IF:INTERESTED:Product Updates:Beta|*beta*|ELSE:|*general*|END:IF|*`,
		map[string]any{"interests": []string{"Product Updates:Beta"}},
	)
	if strings.TrimSpace(html) != "beta" {
		t.Fatalf("html = %q", html)
	}
	if len(unsupported) != 0 {
		t.Fatalf("unsupported = %v", unsupported)
	}
}

func TestConvertVideoForEmail(t *testing.T) {
	out := convertVideoForEmail(VideoConvertInput{
		URL:   "https://www.youtube.com/watch?v=abc123",
		Title: "Product demo",
	})
	if out.Provider != "youtube" || out.VideoID != "abc123" {
		t.Fatalf("provider/video = %s/%s", out.Provider, out.VideoID)
	}
	if !strings.Contains(out.ThumbnailURL, "img.youtube.com/vi/abc123") {
		t.Fatalf("thumbnail = %s", out.ThumbnailURL)
	}
	if out.MergeTag != "*|VIDEO:abc123|*" {
		t.Fatalf("merge tag = %s", out.MergeTag)
	}
	if out.Pipeline != "linked_thumbnail" || out.UploadSupported {
		t.Fatalf("unexpected video pipeline: %#v", out)
	}
	if !strings.Contains(out.EmailHTML, "Product demo") {
		t.Fatalf("email html = %s", out.EmailHTML)
	}
}

func TestInlineAISMSAddsComplianceLanguage(t *testing.T) {
	out := inlineAIResponse(InlineAIInput{Channel: "sms", Mode: "sms", Text: "Sale starts today"})
	if out.Channel != "sms" {
		t.Fatalf("channel = %s", out.Channel)
	}
	if !strings.Contains(strings.ToUpper(out.Text), "STOP") {
		t.Fatalf("sms text missing STOP: %s", out.Text)
	}
	if out.Metadata["sms_segments"] == nil {
		t.Fatalf("sms metadata = %#v", out.Metadata)
	}
}
