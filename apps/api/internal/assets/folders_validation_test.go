package assets

import "testing"

func TestNormalizeFolderNameRejectsControlAndBidiText(t *testing.T) {
	t.Parallel()

	for _, value := range []string{"line\nbreak", "tab\tname", "spoof\u202ename"} {
		if got := normalizeFolderName(value); got != "" {
			t.Errorf("normalizeFolderName(%q) = %q, want rejection", value, got)
		}
	}
	if got := normalizeFolderName("  Campaign   Images  "); got != "Campaign Images" {
		t.Errorf("normalizeFolderName() = %q, want collapsed safe name", got)
	}
}
