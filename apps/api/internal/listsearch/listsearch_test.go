package listsearch

import (
	"net/url"
	"testing"
)

func TestReadQuery(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"empty", "", ""},
		{"query takes precedence", "query=hello&q=ignored", "hello"},
		{"q fallback", "q=fallback", "fallback"},
		{"trims whitespace", "query=%20%20foo%20", "foo"},
		{"empty values are skipped", "query=&q=actual", "actual"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vals, err := url.ParseQuery(tc.raw)
			if err != nil {
				t.Fatalf("parse query: %v", err)
			}
			got := ReadQuery(vals)
			if got != tc.want {
				t.Fatalf("ReadQuery(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestBuildLikeFilter(t *testing.T) {
	frag, args := BuildLikeFilter("name", "", 2)
	if frag != "" || args != nil {
		t.Fatalf("empty query should be no-op, got %q %v", frag, args)
	}
	frag, args = BuildLikeFilter("name", "  acme  ", 3)
	want := "(name ILIKE '%' || $3 || '%')"
	if frag != want {
		t.Fatalf("frag = %q, want %q", frag, want)
	}
	if len(args) != 1 || args[0] != "acme" {
		t.Fatalf("args = %v, want [acme]", args)
	}
}

func TestBuildLikeFilterMulti(t *testing.T) {
	frag, args := BuildLikeFilterMulti([]string{"name", "subject"}, "x", 5)
	want := "(name ILIKE '%' || $5 || '%' OR subject ILIKE '%' || $5 || '%')"
	if frag != want {
		t.Fatalf("frag = %q, want %q", frag, want)
	}
	if len(args) != 1 || args[0] != "x" {
		t.Fatalf("args = %v", args)
	}
	frag, args = BuildLikeFilterMulti([]string{"a"}, "", 1)
	if frag != "" || args != nil {
		t.Fatalf("empty query should be no-op")
	}
}
