package lists

import (
	"context"
	"errors"
	"testing"
)

func TestParseInt64StrictAcceptsOnlyCanonicalPositiveDecimal(t *testing.T) {
	for _, raw := range []string{"1", "42", "9223372036854775807"} {
		if _, ok := parseInt64Strict(raw); !ok {
			t.Errorf("parseInt64Strict(%q) rejected canonical positive decimal", raw)
		}
	}
	for _, raw := range []string{
		"", "0", "00", "01", "-1", "+1", " 1", "1 ", "1.0",
		"9223372036854775808",
	} {
		if _, ok := parseInt64Strict(raw); ok {
			t.Errorf("parseInt64Strict(%q) accepted non-canonical id", raw)
		}
	}
}

// TestResolveListUUIDValidatesPublicIDsBeforeTheDatabase pins the shape
// check. A well-formed uuid is no longer accepted on its shape alone — it must
// name a live list (see TestListScopedRoutesRefuseUnknownAndDeletedLists) — so
// without the repository even a canonical uuid cannot resolve.
func TestResolveListUUIDValidatesPublicIDsBeforeTheDatabase(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.resolveListUUID(
		context.Background(),
		"tenant-unused",
		"F47AC10B-58CC-4372-A567-0E02B2C3D479",
	); !errors.Is(err, ErrListsRepoUnavailable) {
		t.Fatalf("well-formed uuid without a repository: error=%v, want ErrListsRepoUnavailable", err)
	}

	for _, raw := range []string{
		"not-a-uuid",
		"f47ac10b58cc4372a5670e02b2c3d479",
		"{f47ac10b-58cc-4372-a567-0e02b2c3d479}",
		"urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479",
		"0",
		"-7",
	} {
		_, err := repo.resolveListUUID(context.Background(), "tenant-unused", raw)
		if !errors.Is(err, ErrInvalidListID) {
			t.Errorf("resolveListUUID(%q) error=%v, want ErrInvalidListID", raw, err)
		}
	}
}

func TestCountListAudienceRejectsInvalidIdentityAndMissingRepository(t *testing.T) {
	var repo *Repo
	for _, raw := range []string{"not-an-id", " 42 ", " "} {
		if _, err := repo.CountListAudience(context.Background(), "tenant", raw); !errors.Is(err, ErrInvalidListID) {
			t.Fatalf("invalid id %q error=%v, want ErrInvalidListID", raw, err)
		}
	}
	if _, err := repo.CountListAudience(context.Background(), "tenant", testPostwaveListUUID); !errors.Is(err, ErrListsRepoUnavailable) {
		t.Fatalf("missing repo error=%v, want ErrListsRepoUnavailable", err)
	}
}

func TestAddCreatedListIdentityPreservesExactLargeEngineID(t *testing.T) {
	body := []byte(`{"data":{"id":9007199254740993,"name":"Exact"},"meta":{"request":"abc"}}`)
	got, err := addCreatedListIdentity(body, testPostwaveListUUID)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"id":9007199254740993`,
		`"postwave_uuid":"` + testPostwaveListUUID + `"`,
		`"request":"abc"`,
	} {
		if !containsJSONFragment(got, want) {
			t.Errorf("response=%s, want fragment %s", got, want)
		}
	}
}

func containsJSONFragment(body []byte, fragment string) bool {
	for i := 0; i+len(fragment) <= len(body); i++ {
		if string(body[i:i+len(fragment)]) == fragment {
			return true
		}
	}
	return false
}
