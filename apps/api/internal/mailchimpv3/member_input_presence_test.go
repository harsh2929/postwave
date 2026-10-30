// SPDX-License-Identifier: AGPL-3.0-only

package mailchimpv3

import (
	"encoding/json"
	"testing"
)

func TestMemberInputDistinguishesOmittedAndExplicitEmptyMergeFields(t *testing.T) {
	t.Parallel()

	var omitted MemberInput
	if err := json.Unmarshal([]byte(`{"email_address":"omit@example.test"}`), &omitted); err != nil {
		t.Fatalf("decode omitted input: %v", err)
	}
	if omitted.MergeFields != nil {
		t.Fatalf("omitted merge_fields = %#v; want nil", omitted.MergeFields)
	}
	if omitted.Status != "" || omitted.StatusIfNew != "" || omitted.Interests != nil {
		t.Fatalf("omitted patch fields lost presence: status=%q status_if_new=%q interests=%#v",
			omitted.Status, omitted.StatusIfNew, omitted.Interests)
	}

	var clear MemberInput
	if err := json.Unmarshal([]byte(`{"email_address":"clear@example.test","merge_fields":{}}`), &clear); err != nil {
		t.Fatalf("decode explicit clear input: %v", err)
	}
	if clear.MergeFields == nil || len(clear.MergeFields) != 0 {
		t.Fatalf("explicit empty merge_fields = %#v; want non-nil empty map", clear.MergeFields)
	}

	var clearInterests MemberInput
	if err := json.Unmarshal([]byte(`{"email_address":"clear@example.test","interests":{}}`), &clearInterests); err != nil {
		t.Fatalf("decode explicit interests clear: %v", err)
	}
	if clearInterests.Interests == nil || len(clearInterests.Interests) != 0 {
		t.Fatalf("explicit empty interests = %#v; want non-nil empty map", clearInterests.Interests)
	}
}
