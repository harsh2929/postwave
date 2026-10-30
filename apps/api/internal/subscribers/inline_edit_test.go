// SPDX-License-Identifier: AGPL-3.0-only
//
// inline_edit_test.go — SUB-077: inline edit cells (status dropdown +
// tag remove) in the subscriber list table.
//
// SUB-077 is a FRONTEND-ONLY feature: the list-view inline cells reuse the
// existing PATCH /api/v1/subscribers/{id} endpoint with the minimal
// {status} (status dropdown) and {tags} (tag remove) payloads. No new
// backend endpoint, repo method, or migration is required.
//
// These tests pin the backend CONTRACT the inline-edit cells depend on so a
// future refactor of UpdateInput / normalizeUpdate cannot silently break the
// list-view optimistic mutations:
//
//   - a status-only patch validates and leaves every other field a no-op;
//   - an invalid status is rejected (the dropdown only offers valid values,
//     but the server must still guard);
//   - a tags-only patch (the result of removing one chip and re-sending the
//     surviving tags) validates, de-dupes, and drops blanks;
//   - an empty tags slice (remove the last chip) is a valid, non-nil patch
//     that clears the tag set rather than being treated as "omitted".
package subscribers

import "testing"

// TestNormalizeUpdate_InlineStatusOnly: the status dropdown sends just
// {"status":"disabled"}. It must validate, lowercase/trim, and leave the
// tags pointer nil (no-op) so the inline edit touches only status.
func TestNormalizeUpdate_InlineStatusOnly(t *testing.T) {
	status := "  Disabled "
	in := UpdateInput{Status: &status}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("normalizeUpdate(status-only): %v", err)
	}
	if in.Status == nil || *in.Status != StatusDisabled {
		t.Fatalf("Status = %v, want %q", in.Status, StatusDisabled)
	}
	if in.Tags != nil {
		t.Fatalf("Tags = %v, want nil (untouched on a status-only patch)", in.Tags)
	}
}

// TestNormalizeUpdate_InlineStatusInvalid: a junk status from a drifted
// client is rejected so the inline dropdown can surface an error toast
// rather than persisting garbage.
func TestNormalizeUpdate_InlineStatusInvalid(t *testing.T) {
	status := "archived" // not an engine status
	in := UpdateInput{Status: &status}
	if err := normalizeUpdate(&in); err == nil {
		t.Fatalf("normalizeUpdate(invalid status) = nil, want error")
	}
}

// TestNormalizeUpdate_InlineTagRemove: removing one chip re-sends the
// surviving tags. The patch must validate, de-dupe (case-insensitively),
// and drop blank entries while leaving status a no-op.
func TestNormalizeUpdate_InlineTagRemove(t *testing.T) {
	in := UpdateInput{Tags: []string{"vip", " VIP ", "", "founder"}}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("normalizeUpdate(tags-only): %v", err)
	}
	if in.Status != nil {
		t.Fatalf("Status = %v, want nil (untouched on a tags-only patch)", in.Status)
	}
	if len(in.Tags) != 2 {
		t.Fatalf("Tags = %v, want [vip founder] after dedupe/blank-drop", in.Tags)
	}
	if in.Tags[0] != "vip" || in.Tags[1] != "founder" {
		t.Fatalf("Tags = %v, want [vip founder]", in.Tags)
	}
}

// TestNormalizeUpdate_InlineRemoveLastTag: removing the LAST chip sends an
// empty (but non-nil) slice. normalizeUpdate must keep it non-nil so the
// repo writes an empty tag set (clear) rather than treating it as "omitted".
func TestNormalizeUpdate_InlineRemoveLastTag(t *testing.T) {
	in := UpdateInput{Tags: []string{}}
	if err := normalizeUpdate(&in); err != nil {
		t.Fatalf("normalizeUpdate(empty tags): %v", err)
	}
	if in.Tags == nil {
		t.Fatalf("Tags = nil after normalizing an explicit empty slice; " +
			"removing the last chip must stay a clear, not an omit")
	}
	if len(in.Tags) != 0 {
		t.Fatalf("Tags = %v, want empty", in.Tags)
	}
}
