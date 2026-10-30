// SPDX-License-Identifier: AGPL-3.0-only

package archive

import "testing"

func TestFirstImageURL(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "no images",
			body: `<p>Hello world</p>`,
			want: "",
		},
		{
			name: "first public image wins",
			body: `<p>Hi</p><img src="https://cdn.example.com/a.png"><img src="https://cdn.example.com/b.png">`,
			want: "https://cdn.example.com/a.png",
		},
		{
			name: "skips private/SSRF first image, takes next public",
			body: `<img src="http://169.254.169.254/latest/meta-data"><img src="https://cdn.example.com/ok.jpg">`,
			want: "https://cdn.example.com/ok.jpg",
		},
		{
			name: "skips relative + data URIs",
			body: `<img src="/local.png"><img src="data:image/png;base64,AAA"><img src="https://cdn.example.com/real.png">`,
			want: "https://cdn.example.com/real.png",
		},
		{
			name: "single-quoted + extra attrs",
			body: `<img alt="hero" src='https://img.example.com/h.webp' width="600">`,
			want: "https://img.example.com/h.webp",
		},
		{
			name: "all candidates non-public => empty",
			body: `<img src="http://127.0.0.1/x.png"><img src="/rel.png">`,
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstImageURL(tc.body); got != tc.want {
				t.Fatalf("firstImageURL = %q, want %q", got, tc.want)
			}
		})
	}
}
