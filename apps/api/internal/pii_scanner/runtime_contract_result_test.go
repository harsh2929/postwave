// SPDX-License-Identifier: AGPL-3.0-only

package pii_scanner

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestApplyRuntimeContractResultFailsClosedWithoutSingleton(t *testing.T) {
	cfg := &ScanConfig{
		RuntimeAvailability: "available",
		RuntimeScanContract: "stale-contract",
	}

	if err := applyRuntimeContractResult(cfg, nil, pgx.ErrNoRows); err != nil {
		t.Fatalf("missing runtime singleton: %v", err)
	}
	if cfg.RuntimeAvailability != "unknown" || cfg.RuntimeScanContract != "" {
		t.Fatalf("missing runtime singleton did not fail closed: %+v", cfg)
	}
}

func TestApplyRuntimeContractResultPreservesReadAndRealErrors(t *testing.T) {
	contract := "scanner=v1"
	cfg := &ScanConfig{RuntimeAvailability: "available"}
	if err := applyRuntimeContractResult(cfg, &contract, nil); err != nil {
		t.Fatalf("valid runtime result: %v", err)
	}
	if cfg.RuntimeScanContract != contract {
		t.Fatalf("runtime contract = %q, want %q", cfg.RuntimeScanContract, contract)
	}

	want := errors.New("runtime query failed")
	if got := applyRuntimeContractResult(&ScanConfig{}, nil, want); !errors.Is(got, want) {
		t.Fatalf("query error = %v, want %v", got, want)
	}
	if got := applyRuntimeContractResult(nil, nil, nil); !errors.Is(got, ErrInvalidInput) {
		t.Fatalf("nil config error = %v, want ErrInvalidInput", got)
	}
}
