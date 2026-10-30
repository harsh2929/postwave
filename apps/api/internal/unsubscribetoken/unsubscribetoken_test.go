// SPDX-License-Identifier: AGPL-3.0-only

package unsubscribetoken

import "testing"

func TestIsNameAcceptsExactlyTheRenderedSpellings(t *testing.T) {
	for _, name := range []string{"unsubscribe_url", "Unsubscribe.URL", "UnsubscribeURL"} {
		if !IsName(name) {
			t.Errorf("IsName(%q) = false, want true", name)
		}
	}
	for _, name := range []string{
		"", "unsubscribe", "UNSUBSCRIBE_URL", "unsubscribe_link", "manage_url",
		" unsubscribe_url", "unsubscribe_url ",
	} {
		if IsName(name) {
			t.Errorf("IsName(%q) = true, want false", name)
		}
	}
}

func TestContainsRequiresABracedPlaceholder(t *testing.T) {
	cases := map[string]bool{
		`<a href="{{ unsubscribe_url }}">x</a>`:            true,
		`<a href="{{unsubscribe_url}}">x</a>`:              true,
		"<a href=\"{{\tunsubscribe_url\n}}\">x</a>":        true,
		`<a href="{{ Unsubscribe.URL }}">x</a>`:            true,
		`<a href="{{UnsubscribeURL}}">x</a>`:               true,
		`<a href="https://moosewave.com/unsubscribe">x</a>`: false,
		`<a href="{{ unsubscribe_url | upper }}">x</a>`:    false,
		`<a href="{{ UnsubscribeXURL }}">x</a>`:            false,
		`unsubscribe_url`:                                  false,
		`<p>Unsubscribe any time.</p>`:                     false,
		``:                                                 false,
	}
	for body, want := range cases {
		if got := Contains(body); got != want {
			t.Errorf("Contains(%q) = %v, want %v", body, got, want)
		}
	}
}

func TestRenderReplacesEveryPlaceholderAndOnlyThose(t *testing.T) {
	const url = "https://app.example.com/preferences/0f9a"
	body := `<a href="{{ unsubscribe_url }}">a</a><a href="{{unsubscribe_url}}">b</a>` +
		"<a href=\"{{  Unsubscribe.URL\t}}\">c</a><a href=\"{{UnsubscribeURL}}\">d</a>" +
		`<p>{{ first_name }}</p>`
	want := `<a href="` + url + `">a</a><a href="` + url + `">b</a>` +
		`<a href="` + url + `">c</a><a href="` + url + `">d</a>` +
		`<p>{{ first_name }}</p>`
	if got := Render(body, url); got != want {
		t.Fatalf("Render =\n%s\nwant\n%s", got, want)
	}
	if got := Render(body, ""); got != body {
		t.Fatalf("Render with empty url changed the body: %q", got)
	}
	// A URL containing replacement metacharacters is inserted literally.
	if got := Render(`{{ unsubscribe_url }}`, "https://x.example/$1"); got != "https://x.example/$1" {
		t.Fatalf("Render expanded a replacement pattern: %q", got)
	}
}
