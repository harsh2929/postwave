// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

// TestMainDelegatesDeliverabilitySurfaceToServer prevents individual mounts
// from drifting back into the composition root or escaping the authenticated
// route block. The server package owns the exact route set and scope tests.
func TestMainDelegatesDeliverabilitySurfaceToServer(t *testing.T) {
	t.Parallel()

	root := readAPICompositionRoot(t)
	source := root.main

	for _, forbidden := range []string{
		"tag_taxonomy.MountRoutes(r,",
		"growth_source.MountRoutes(r,",
		"isp_breakdown.MountRoutes(r,",
		"campaign_benchmarks.MountRoutes(r,",
		"campaign_to_template.MountRoutes(r,",
		"dns_health.MountRoutes(r,",
		"deliverability_hub.MountRoutes(r,",
		"firewall_attack_mode.MountRoutes(r,",
		"freq_caps.MountRoutes(r,",
		"inactive_keys.MountRoutes(r,",
		"from_name_picker.MountRoutes(r,",
		"preset_segments.MountRoutes(r,",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("composition root bypasses server.MountDeliverabilitySurface with %q", forbidden)
		}
	}

	ordered := []string{
		"apiserver.MountCampaignDeliveryUtilities(",
		"deliverabilitySurface := apiserver.MountDeliverabilitySurface(apiserver.Deps{",
		"apiworkers.StartDeliverabilityHub(outboxCtx, logger, deliverabilitySurface.Hub)",
		"apiserver.MountSubscriberCampaignInsightRoutes(",
	}
	last := -1
	for _, marker := range ordered {
		index := strings.Index(source, marker)
		if index < 0 {
			t.Fatalf("main.go is missing deliverability composition marker %q", marker)
		}
		if index <= last {
			t.Fatalf("deliverability composition marker %q is out of order", marker)
		}
		last = index
	}

	for _, wiring := range []string{
		"Router: r, Pool: pool, Bus: eventsBus, Logger: logger,",
		"TagHistory: tagsHistory,",
	} {
		if !strings.Contains(source, wiring) {
			t.Fatalf("deliverability server dependencies missing %q", wiring)
		}
	}
}
