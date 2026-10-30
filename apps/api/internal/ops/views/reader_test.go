package views

import "testing"

func TestEscapeLikePrefix(t *testing.T) {
	const input = `50%_off\today`
	const want = `50\%\_off\\today`
	if got := escapeLikePrefix(input); got != want {
		t.Fatalf("escapeLikePrefix(%q) = %q, want %q", input, got, want)
	}
}
