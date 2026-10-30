package campaigns

import "testing"

func TestPlainTextBodyHTML(t *testing.T) {
	got := plainTextBodyHTML("Hello <Ada>\nTrack & learn")
	want := "<div>Hello &lt;Ada&gt;<br>\nTrack &amp; learn</div>"
	if got != want {
		t.Fatalf("plainTextBodyHTML() = %q, want %q", got, want)
	}
}
