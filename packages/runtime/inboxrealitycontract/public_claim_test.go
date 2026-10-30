// SPDX-License-Identifier: AGPL-3.0-only

package inboxrealitycontract

import (
	"strings"
	"testing"
	"time"
)

func seedlist(active int) SeedlistResponse {
	seeds := make([]SeedEntry, 0, active)
	for index := 0; index < active; index++ {
		seeds = append(seeds, SeedEntry{
			MailboxID: "m", Provider: "gmail", Address: "a@example.test",
		})
	}
	return SeedlistResponse{
		ContractVersion: SeedlistVersion,
		Seeds:           seeds,
		CapturedAt:      time.Now(),
	}
}

func TestASeedlistSmallerThanTheProductionMinimumIsRefused(t *testing.T) {
	err := VerifyProductionSeedlistCapacity(seedlist(ProductionSeedlistMinimum - 1))
	if err == nil {
		t.Fatal("a seedlist below the production minimum was accepted")
	}
	// The error has to be actionable at 3am by someone who has never read this
	// file, so it names both numbers.
	if !strings.Contains(err.Error(), "seedlist") {
		t.Errorf("error does not identify the subject: %v", err)
	}
}

func TestAnExactOrLargerSeedlistIsAccepted(t *testing.T) {
	if err := VerifyProductionSeedlistCapacity(seedlist(ProductionSeedlistMinimum)); err != nil {
		t.Errorf("a seedlist matching the production minimum was refused: %v", err)
	}
	if err := VerifyProductionSeedlistCapacity(seedlist(ProductionSeedlistMinimum + 5)); err != nil {
		t.Errorf("a seedlist larger than the production minimum was refused: %v", err)
	}
}

func TestAnEmptySeedlistIsRefused(t *testing.T) {
	// Zero is the shape a misconfigured or unreachable service produces, and it
	// must not read as "claim satisfied" under any comparison.
	if err := VerifyProductionSeedlistCapacity(seedlist(0)); err == nil {
		t.Error("an empty seedlist satisfied the production capacity gate")
	}
}

func TestTheProductionMinimumIsPositive(t *testing.T) {
	// A zero minimum would make the gate vacuous: everything would satisfy it,
	// including a service returning nothing.
	if ProductionSeedlistMinimum <= 0 {
		t.Fatalf("ProductionSeedlistMinimum = %d, which no seedlist can fail", ProductionSeedlistMinimum)
	}
}
