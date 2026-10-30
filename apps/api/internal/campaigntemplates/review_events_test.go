// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import "testing"

func TestValidateTemplateReviewInput(t *testing.T) {
	for _, test := range []struct {
		in   templateReviewInput
		want bool
	}{
		{templateReviewInput{Version: 2, Kind: "comment", Body: "Please fix the footer"}, true},
		{templateReviewInput{Version: 2, Kind: "request_changes", Body: "Missing alt text"}, true},
		{templateReviewInput{Version: 2, Kind: "approve"}, true},
		{templateReviewInput{Version: 0, Kind: "approve"}, false},
		{templateReviewInput{Version: 2, Kind: "approve", Body: "hidden note"}, false},
		{templateReviewInput{Version: 2, Kind: "comment", Body: "   "}, false},
		{templateReviewInput{Version: 2, Kind: "delete", Body: "x"}, false},
	} {
		if got := validateTemplateReviewInput(test.in); got != test.want {
			t.Errorf("validateTemplateReviewInput(%+v) = %v, want %v", test.in, got, test.want)
		}
	}
}
