package engagementclassification

import (
	"os"
	"testing"
)

// readSource reads a file in this package, with a floor so a truncated or
// missing read cannot make a containment assertion pass vacuously.
func readSource(t *testing.T, name string) string {
	t.Helper()
	body, err := os.ReadFile(name)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if len(body) < 500 {
		t.Fatalf("%s is %d bytes; assertions over it would be vacuous", name, len(body))
	}
	return string(body)
}
