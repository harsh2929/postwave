// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for the read-only ip_pool projection on GET
// /api/v1/settings/sending (desktop-audit gap A25). The projection is
// derived from dedicated_ip_assignments (migration 0114) via the
// IPAssignmentLister seam, so everything here runs without a DB.
package sendingsettings

import (
	"context"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/sending"
)

func TestIPPoolFromAssignments(t *testing.T) {
	cases := []struct {
		name        string
		assignments []sending.Assignment
		wantName    string
		wantDedic   bool
	}{
		{"no assignments → shared platform pool", nil, "shared", false},
		{"empty slice → shared platform pool", []sending.Assignment{}, "shared", false},
		{
			"labeled pool",
			[]sending.Assignment{{IP: "192.0.2.10", Pool: "marketing-a", Status: sending.AssignmentActive}},
			"marketing-a", true,
		},
		{
			"unlabeled legacy row falls back to 'dedicated'",
			[]sending.Assignment{{IP: "192.0.2.11", Status: sending.AssignmentActive}},
			"dedicated", true,
		},
		{
			"multiple assignments use the first pool label",
			[]sending.Assignment{
				{IP: "192.0.2.12", Pool: "pool-1", Status: sending.AssignmentActive},
				{IP: "192.0.2.13", Pool: "pool-2", Status: sending.AssignmentActive},
			},
			"pool-1", true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ipPoolFromAssignments(tc.assignments)
			if got == nil {
				t.Fatal("ipPoolFromAssignments returned nil")
			}
			if got.Name != tc.wantName || got.Dedicated != tc.wantDedic {
				t.Errorf("got %+v, want {Name:%q Dedicated:%v}", got, tc.wantName, tc.wantDedic)
			}
		})
	}
}

type fakeIPLister struct {
	assignments []sending.Assignment
	err         error
}

func (f *fakeIPLister) ListActiveForTenant(context.Context, string) ([]sending.Assignment, error) {
	return f.assignments, f.err
}

func TestResolveIPPool(t *testing.T) {
	const tenantID = "00000000-0000-0000-0000-000000000001"

	t.Run("nil lister omits the field (honest unknown)", func(t *testing.T) {
		d := &Deps{}
		if got := d.resolveIPPool(context.Background(), tenantID); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})

	t.Run("lister error omits the field instead of fabricating shared", func(t *testing.T) {
		d := &Deps{IPs: &fakeIPLister{err: errors.New("boom")}}
		if got := d.resolveIPPool(context.Background(), tenantID); got != nil {
			t.Errorf("got %+v, want nil", got)
		}
	})

	t.Run("no active assignments → shared", func(t *testing.T) {
		d := &Deps{IPs: &fakeIPLister{}}
		got := d.resolveIPPool(context.Background(), tenantID)
		if got == nil || got.Name != "shared" || got.Dedicated {
			t.Errorf("got %+v, want {Name:shared Dedicated:false}", got)
		}
	})

	t.Run("active assignment → dedicated pool", func(t *testing.T) {
		d := &Deps{IPs: &fakeIPLister{assignments: []sending.Assignment{
			{IP: "192.0.2.20", Pool: "warm-pool", Status: sending.AssignmentActive},
		}}}
		got := d.resolveIPPool(context.Background(), tenantID)
		if got == nil || got.Name != "warm-pool" || !got.Dedicated {
			t.Errorf("got %+v, want {Name:warm-pool Dedicated:true}", got)
		}
	})
}
