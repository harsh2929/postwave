// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func blocking(names ...string) []BlockingCampaign {
	out := make([]BlockingCampaign, 0, len(names))
	for i, name := range names {
		out = append(out, BlockingCampaign{ID: fmt.Sprintf("c%d", i), Name: name, Status: "draft"})
	}
	return out
}

func TestSegmentInUseMessageNamesWhatToMove(t *testing.T) {
	cases := []struct {
		name string
		err  SegmentInUseError
		want string
	}{
		{
			name: "one campaign",
			err:  SegmentInUseError{Campaigns: blocking("Spring launch"), Total: 1},
			want: `This segment is the audience of the campaign "Spring launch", which hasn't sent yet. Move that campaign to another audience, or delete it, before deleting this segment.`,
		},
		{
			name: "every blocking campaign named",
			err:  SegmentInUseError{Campaigns: blocking("A", "B", "C"), Total: 3},
			want: `This segment is the audience of 3 campaigns that haven't sent yet: "A", "B" and "C". Move them to another audience, or delete them, before deleting this segment.`,
		},
		{
			name: "more than are named",
			err:  SegmentInUseError{Campaigns: blocking("A", "B", "C", "D", "E"), Total: 9},
			want: `This segment is the audience of 9 campaigns that haven't sent yet, including "A", "B", "C", "D" and "E". Move them to another audience, or delete them, before deleting this segment.`,
		},
		{
			name: "the blocking campaign moved on before it could be named",
			err:  SegmentInUseError{},
			want: "A campaign that hasn't sent yet was using this segment as its audience when you tried to delete it. Check the campaigns that use this segment, then try again.",
		},
	}
	for _, tc := range cases {
		if got := tc.err.Message(); got != tc.want {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
	}
}

func TestSegmentInUseErrorUnwrapsToTheSentinel(t *testing.T) {
	err := fmt.Errorf("delete: %w", &SegmentInUseError{Campaigns: blocking("A"), Total: 1})
	if !errors.Is(err, ErrSegmentInUse) {
		t.Fatalf("errors.Is(%v, ErrSegmentInUse) = false", err)
	}
	var inUse *SegmentInUseError
	if !errors.As(err, &inUse) || inUse.Total != 1 {
		t.Fatalf("errors.As lost the refusal: %v", err)
	}
	if !strings.Contains(err.Error(), "1 campaign") {
		t.Fatalf("Error() = %q", err.Error())
	}
}

// Only the 1876 trigger's refusal is a "segment in use" 409. A foreign-key
// violation from anywhere else names its constraint and is an ordinary error,
// not a refusal that would tell the user a campaign is in the way.
func TestOnlyTheTriggersRefusalIsASegmentInUse(t *testing.T) {
	trigger := &pgconn.PgError{
		Code:    "23503",
		Message: "segment is the audience of 1 campaign(s) that have not sent yet (Spring). Deleting it would retarget them at every subscriber. Point those campaigns at another audience first.",
		Where:   "PL/pgSQL function refuse_segment_delete_with_sendable_campaigns() line 17 at RAISE",
	}
	if !isSendableCampaignRefusal(fmt.Errorf("delete: %w", trigger)) {
		t.Fatal("the trigger's refusal was not recognised")
	}
	foreignKey := &pgconn.PgError{Code: "23503", ConstraintName: "segment_notes_segment_id_fkey", TableName: "segment_notes"}
	if isSendableCampaignRefusal(foreignKey) {
		t.Fatal("an ordinary foreign-key violation was taken for the trigger's refusal")
	}
	if isSendableCampaignRefusal(errors.New("23503")) {
		t.Fatal("a non-Postgres error was taken for the trigger's refusal")
	}
}
