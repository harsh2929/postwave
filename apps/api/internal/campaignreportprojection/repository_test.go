// SPDX-License-Identifier: AGPL-3.0-only

package campaignreportprojection

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNormalizeRequestAndHashAreCanonical(t *testing.T) {
	tenantID := uuid.NewString()
	requestID := uuid.NewString()
	start := time.Date(2026, 8, 13, 1, 2, 3, 456789000, time.FixedZone("IST", 5*60*60+30*60))
	request, err := normalizeRequest(tenantID, ReconciliationRequest{
		RequestID: requestID, WindowStart: start,
		WindowEnd: start.Add(2 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.ProjectionVersion != ProjectionVersionV1 {
		t.Fatalf("default version=%q", request.ProjectionVersion)
	}
	if request.WindowStart.Location() != time.UTC || request.WindowEnd.Location() != time.UTC {
		t.Fatal("request window was not normalized to UTC")
	}
	first, err := reconciliationRequestHash(request)
	if err != nil {
		t.Fatal(err)
	}
	requestSameInstant := request
	requestSameInstant.WindowStart = request.WindowStart.In(time.FixedZone("other", -7*60*60))
	requestSameInstant.WindowEnd = request.WindowEnd.In(time.FixedZone("other", -7*60*60))
	second, err := reconciliationRequestHash(requestSameInstant)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) != 64 {
		t.Fatalf("canonical request hashes differ: %q %q", first, second)
	}
	request.WindowEnd = request.WindowEnd.Add(time.Nanosecond)
	third, err := reconciliationRequestHash(request)
	if err != nil {
		t.Fatal(err)
	}
	if third == first {
		t.Fatal("material request change did not change request hash")
	}
}

func TestRepositoryValidationIsBounded(t *testing.T) {
	validTenant := uuid.NewString()
	now := time.Now()
	for name, test := range map[string]func() error{
		"bad tenant": func() error {
			return validateProjectionInput("not-a-uuid", EventRef{ID: 1, At: now}, ProjectionVersionV1)
		},
		"missing event": func() error {
			return validateProjectionInput(validTenant, EventRef{}, ProjectionVersionV1)
		},
		"bad version": func() error {
			return validateProjectionInput(validTenant, EventRef{ID: 1, At: now}, "Upper Case")
		},
		"missing worker": func() error {
			_, _, err := (&Repo{}).reconciliationSettings()
			return err
		},
		"oversize worker": func() error {
			_, _, err := (&Repo{WorkerID: strings.Repeat("x", 201)}).reconciliationSettings()
			return err
		},
		"oversize lease": func() error {
			_, _, err := (&Repo{WorkerID: "worker", LeaseTTL: maxLeaseTTL + time.Millisecond}).reconciliationSettings()
			return err
		},
	} {
		t.Run(name, func(t *testing.T) {
			if err := test(); !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error=%v, want ErrInvalidInput", err)
			}
		})
	}
	if err := validateProjectionInput(validTenant,
		EventRef{ID: 1, At: now}, ProjectionVersionV1); err != nil {
		t.Fatalf("valid projection input rejected: %v", err)
	}
	worker, ttl, err := (&Repo{WorkerID: "projection-1"}).reconciliationSettings()
	if err != nil || worker != "projection-1" || ttl != defaultLeaseTTL {
		t.Fatalf("settings worker=%q ttl=%v err=%v", worker, ttl, err)
	}
}
