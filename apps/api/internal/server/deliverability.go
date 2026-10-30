// SPDX-License-Identifier: AGPL-3.0-only

package server

import (
	"github.com/postwave/postwave/apps/api/internal/campaign_benchmarks"
	"github.com/postwave/postwave/apps/api/internal/campaign_to_template"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/dns_health"
	"github.com/postwave/postwave/apps/api/internal/firewall_attack_mode"
	"github.com/postwave/postwave/apps/api/internal/freq_caps"
	"github.com/postwave/postwave/apps/api/internal/from_name_picker"
	"github.com/postwave/postwave/apps/api/internal/growth_source"
	"github.com/postwave/postwave/apps/api/internal/inactive_keys"
	"github.com/postwave/postwave/apps/api/internal/isp_breakdown"
	"github.com/postwave/postwave/apps/api/internal/preset_segments"
	"github.com/postwave/postwave/apps/api/internal/tag_taxonomy"
)

// DeliverabilitySurface exposes the route dependencies also consumed by the
// companion worker. Sharing the Hub pointer preserves the original composition
// contract between HTTP repair overrides and background score recomputation.
type DeliverabilitySurface struct {
	Hub *deliverability_hub.Deps
}

// MountDeliverabilitySurface registers the complete authenticated
// deliverability route group in its original order. The caller must pass the
// existing authenticated chi sub-router; this function deliberately does not
// create a router or install a parallel middleware stack.
func MountDeliverabilitySurface(deps Deps) DeliverabilitySurface {
	if deps.Router == nil || deps.Pool == nil {
		return DeliverabilitySurface{}
	}

	tag_taxonomy.MountRoutes(deps.Router, &tag_taxonomy.Deps{
		Pool:    deps.Pool,
		History: deps.TagHistory,
		Logger:  deps.Logger,
	})
	growth_source.MountRoutes(deps.Router, &growth_source.Deps{Pool: deps.Pool})
	isp_breakdown.MountRoutes(deps.Router, &isp_breakdown.Deps{Pool: deps.Pool})
	campaign_benchmarks.MountRoutes(deps.Router, &campaign_benchmarks.Deps{Pool: deps.Pool})
	campaign_to_template.MountRoutes(deps.Router, &campaign_to_template.Deps{
		Pool:         deps.Pool,
		TemplateRepo: &campaigntemplates.Repo{Pool: deps.Pool},
		Logger:       deps.Logger,
	})

	dnsHealthWorker := &dns_health.Worker{Pool: deps.Pool}
	dns_health.MountRoutes(deps.Router, &dns_health.Deps{
		Pool:   deps.Pool,
		Worker: dnsHealthWorker,
	})
	hubDependencies := &deliverability_hub.Deps{
		Pool:   deps.Pool,
		Bus:    deps.Bus,
		Logger: deps.Logger,
	}
	deliverability_hub.MountRoutes(deps.Router, hubDependencies)

	firewall_attack_mode.MountRoutes(deps.Router, &firewall_attack_mode.Deps{Pool: deps.Pool})
	freq_caps.MountRoutes(deps.Router, &freq_caps.Deps{Repo: &freq_caps.Repo{Pool: deps.Pool}})
	inactive_keys.MountRoutes(deps.Router, &inactive_keys.Deps{Pool: deps.Pool})
	from_name_picker.MountRoutes(deps.Router, &from_name_picker.Deps{Pool: deps.Pool})
	preset_segments.MountRoutes(deps.Router, &preset_segments.Deps{Pool: deps.Pool})

	return DeliverabilitySurface{Hub: hubDependencies}
}
