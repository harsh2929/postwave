package content

import (
	"math"
	"strings"
	"testing"
)

// TestFeatureNamesAndWeightsAlign is a structural guarantee — if anyone adds
// a feature without bumping FeatureCount or weights.go, this test fails
// loudly before any scoring drift can land in production.
func TestFeatureNamesAndWeightsAlign(t *testing.T) {
	if len(FeatureNames) != FeatureCount {
		t.Fatalf("len(FeatureNames)=%d FeatureCount=%d", len(FeatureNames), FeatureCount)
	}
	if len(Weights) != FeatureCount {
		t.Fatalf("len(Weights)=%d FeatureCount=%d", len(Weights), FeatureCount)
	}
	if FeatureNames[FeatureCount-1] != "intercept" {
		t.Fatalf("intercept must be last feature; got %q", FeatureNames[FeatureCount-1])
	}
}

func TestExtract_ReturnsFixedLengthVector(t *testing.T) {
	v := Extract("hello world", "<p>body</p>", nil)
	if len(v) != FeatureCount {
		t.Fatalf("len=%d want %d", len(v), FeatureCount)
	}
	if v[FeatureCount-1] != 1.0 {
		t.Fatalf("intercept must be 1.0, got %v", v[FeatureCount-1])
	}
}

// Each feature gets a directed test with a hand-computed expected value.

func TestSubjectLengthFeature(t *testing.T) {
	v := Extract("hi", "<p>x</p>", nil)
	want := math.Log1p(2) / 7.0
	if math.Abs(v[0]-want) > 1e-9 {
		t.Fatalf("subject_length_chars=%v want %v", v[0], want)
	}
}

func TestSubjectCapsRatio(t *testing.T) {
	v := Extract("HELLO", "<p>x</p>", nil)
	if v[1] != 1.0 {
		t.Fatalf("all-caps subject capsRatio=%v want 1.0", v[1])
	}
	v2 := Extract("hello", "<p>x</p>", nil)
	if v2[1] != 0.0 {
		t.Fatalf("all-lower subject capsRatio=%v want 0.0", v2[1])
	}
}

func TestSubjectExcessivePunct(t *testing.T) {
	if v := Extract("Hello!", "<p>x</p>", nil); v[2] != 0 {
		t.Fatalf("single ! should not trip excessive punct; got %v", v[2])
	}
	if v := Extract("FREE!! NOW!!", "<p>x</p>", nil); v[2] != 1 {
		t.Fatalf("2x !! should trip excessive punct; got %v", v[2])
	}
	if v := Extract("urgent???", "<p>x</p>", nil); v[2] != 1 {
		t.Fatalf("triple ??? should trip; got %v", v[2])
	}
}

func TestSubjectStartsWithReOrFwd(t *testing.T) {
	if v := Extract("Re: project update", "<p>x</p>", nil); v[4] != 1 {
		t.Fatalf("Re: should trip; got %v", v[4])
	}
	if v := Extract("Fwd: invoice", "<p>x</p>", nil); v[4] != 1 {
		t.Fatalf("Fwd: should trip; got %v", v[4])
	}
	if v := Extract("Project update", "<p>x</p>", nil); v[4] != 0 {
		t.Fatalf("plain subject should not; got %v", v[4])
	}
}

func TestBodyLengthFeature(t *testing.T) {
	body := "<p>" + strings.Repeat("a", 1000) + "</p>"
	v := Extract("subj", body, nil)
	if v[5] <= 0.4 || v[5] >= 0.9 {
		t.Fatalf("body_length=%v expected ~0.7", v[5])
	}
}

func TestBodyLinkCountAndDensity(t *testing.T) {
	body := `<p><a href="https://a.com">a</a><a href="https://b.com">b</a><a href="https://c.com">c</a></p>`
	v := Extract("subj", body, nil)
	if v[6] <= 0 {
		t.Fatalf("expected link count > 0; got %v", v[6])
	}
	if v[7] <= 0 {
		t.Fatalf("expected link density > 0; got %v", v[7])
	}
}

func TestBodyImageCountAndRatio(t *testing.T) {
	body := `<html><body><img src="a"/><img src="b"/><p>hi</p></body></html>`
	v := Extract("subj", body, nil)
	if v[8] <= 0 {
		t.Fatalf("expected image count > 0; got %v", v[8])
	}
	if v[9] <= 0 {
		t.Fatalf("expected image-text ratio > 0; got %v", v[9])
	}
}

func TestBodyCapsRatio(t *testing.T) {
	v := Extract("subj", "<p>HELLO HELLO HELLO</p>", nil)
	if v[10] < 0.95 {
		t.Fatalf("all-caps body capsRatio=%v want ~1.0", v[10])
	}
}

func TestBodyAllCapsWordCount(t *testing.T) {
	v := Extract("subj", "<p>This is BIG NEWS for YOU TODAY</p>", nil)
	// "BIG" len=3 not counted (≥4 required). "NEWS"(4),"TODAY"(5) — 2 words.
	// "YOU"(3) not counted.
	if v[11] != 2 {
		t.Fatalf("all_caps_word_count=%v want 2", v[11])
	}
}

func TestExclamationDensity(t *testing.T) {
	v := Extract("subj", "<p>!!!!!!!!!!</p>", nil)
	if v[12] <= 0 {
		t.Fatalf("expected positive exclamation density; got %v", v[12])
	}
}

func TestUrlShortenerCount(t *testing.T) {
	body := `<p><a href="https://bit.ly/abc">x</a> <a href="https://t.co/y">y</a></p>`
	v := Extract("subj", body, nil)
	if v[13] != 2 {
		t.Fatalf("shortener count=%v want 2", v[13])
	}
}

func TestUnicodeObfuscation(t *testing.T) {
	// Cyrillic 'а' (U+0430) in place of latin 'a' in "PayPal"
	body := "<p>PаyPal account login required</p>"
	v := Extract("subj", body, nil)
	if v[14] != 1 {
		t.Fatalf("expected obfuscation flag; got %v", v[14])
	}
	v2 := Extract("subj", "<p>PayPal account</p>", nil)
	if v2[14] != 0 {
		t.Fatalf("plain text should not trip obfuscation; got %v", v2[14])
	}
}

func TestMisspelledWordsProxy(t *testing.T) {
	v := Extract("subj", "<p>freeeeee deal yesss</p>", nil)
	if v[15] < 1 {
		t.Fatalf("expected ≥1 repeated-char run; got %v", v[15])
	}
}

func TestUrgencyMoneyPrizePharmaPhraseCounts(t *testing.T) {
	body := `<p>Act now! Limited time. You've won a prize. Free viagra and weight loss</p>`
	v := Extract("subj", body, nil)
	if v[16] < 2 {
		t.Fatalf("urgency=%v want ≥2", v[16])
	}
	if v[17] < 1 {
		t.Fatalf("money=%v want ≥1", v[17])
	}
	if v[18] < 2 {
		t.Fatalf("prize=%v want ≥2", v[18])
	}
	if v[19] < 2 {
		t.Fatalf("pharma=%v want ≥2", v[19])
	}
}

func TestBrandImpersonation(t *testing.T) {
	// PayPal mentioned in body, link points elsewhere → impersonation
	body := `<p>Verify your PayPal account: <a href="http://evil.example/login">click</a></p>`
	v := Extract("subj", body, nil)
	if v[20] < 1 {
		t.Fatalf("expected impersonation count ≥1; got %v", v[20])
	}
	// PayPal mentioned, link to paypal.com → no impersonation
	body2 := `<p>PayPal blog post: <a href="https://www.paypal.com/blog">link</a></p>`
	v2 := Extract("subj", body2, nil)
	if v2[20] != 0 {
		t.Fatalf("matching brand+host should not trip; got %v", v2[20])
	}
}

func TestLinkTextMismatchesHref(t *testing.T) {
	body := `<p><a href="http://evil.example">https://www.bank.com</a></p>`
	v := Extract("subj", body, nil)
	if v[21] < 1 {
		t.Fatalf("expected mismatch count ≥1; got %v", v[21])
	}
}

func TestTextToHtmlRatio(t *testing.T) {
	body := `<p>hello there friends</p>`
	v := Extract("subj", body, nil)
	if v[22] <= 0 || v[22] > 1 {
		t.Fatalf("text_to_html=%v out of (0,1]", v[22])
	}
}

func TestSubjectFakeReplyWithoutThread(t *testing.T) {
	// thread context says "no In-Reply-To, no References" — and subject is "Re: ..."
	tc := &ThreadContext{HasReferencesHeader: false, HasInReplyTo: false}
	v := Extract("Re: invoice", "<p>x</p>", tc)
	if v[23] != 1 {
		t.Fatalf("fake reply should trip; got %v", v[23])
	}
	// when caller doesn't pass thread context we cannot tell — must be 0
	v2 := Extract("Re: invoice", "<p>x</p>", nil)
	if v2[23] != 0 {
		t.Fatalf("no thread ctx must yield 0; got %v", v2[23])
	}
	// genuine reply (has References header)
	tc2 := &ThreadContext{HasReferencesHeader: true}
	v3 := Extract("Re: invoice", "<p>x</p>", tc2)
	if v3[23] != 0 {
		t.Fatalf("genuine reply must not trip; got %v", v3[23])
	}
}

func TestFeatureMap(t *testing.T) {
	v := Extract("subj", "<p>x</p>", nil)
	m := FeatureMap(v)
	if len(m) != FeatureCount {
		t.Fatalf("map size=%d want %d", len(m), FeatureCount)
	}
	if _, ok := m["intercept"]; !ok {
		t.Fatal("expected intercept key")
	}
}
