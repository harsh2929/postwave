package content

import (
	"strings"
	"testing"
)

func TestAnalyzeHTMLQuality_FixtureCases(t *testing.T) {
	type tc struct {
		name string
		html string
		want []string // substrings each issue list must contain at least one match for
	}
	cases := []tc{
		{
			name: "missing alt + script + no unsubscribe",
			html: `<html><body><img src="a"/><script>x</script><a>click</a></body></html>`,
			want: []string{"alt", "script", "unsubscribe"},
		},
		{
			name: "iframe + form",
			html: `<html><body><iframe src="x"></iframe><form><a href="https://e/u">unsubscribe</a></form></body></html>`,
			want: []string{"iframe", "form"},
		},
		{
			name: "white-on-white inline style",
			html: `<html><body><span style="color:#fff">hidden text</span><a href="x">unsubscribe</a></body></html>`,
			want: []string{"hidden white text"},
		},
		{
			name: "tiny font size",
			html: `<html><body><span style="font-size:6px">tiny</span><a href="x">unsubscribe</a></body></html>`,
			want: []string{"tiny font-size"},
		},
		{
			name: "display none with content",
			html: `<html><body><div style="display:none">hidden bonus</div><a href="x">unsubscribe</a></body></html>`,
			want: []string{"display:none"},
		},
		{
			name: "encoded chars obfuscation",
			html: `<html><body><p>f&#114;ee m&#111;ney now</p><a href="x">unsubscribe</a></body></html>`,
			want: []string{"numeric character entities"},
		},
		{
			name: "mismatched tags",
			html: `<html><body><div><span>oops</div><a href="x">unsubscribe</a></body></html>`,
			want: []string{"mismatched"},
		},
		{
			name: "clean enough body still flags missing unsubscribe when absent",
			html: `<html><body><p>plain content</p></body></html>`,
			want: []string{"unsubscribe"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := AnalyzeHTMLQuality(c.html)
			joined := strings.Join(issues, "|")
			for _, w := range c.want {
				if !strings.Contains(joined, w) {
					t.Errorf("expected substring %q in %q", w, joined)
				}
			}
		})
	}
}
