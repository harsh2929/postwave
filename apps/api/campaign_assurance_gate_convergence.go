// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/config"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/presend"
)

// campaignAssuranceGateConvergence is the composition hook shared by the
// campaign queue and pre-send endpoint. It intentionally does not mutate a
// live dependency graph; callers apply it before mounting routes/workers.
type campaignAssuranceGateConvergence struct {
	Rollout *campaignassurancegate.Rollout
}

// resolveCampaignAssuranceGateRollout keeps the retired boolean as an exact
// block-mode alias while making the staged policy explicit for new
// deployments. Conflicting controls fail startup instead of silently choosing
// a weaker policy.
func resolveCampaignAssuranceGateRollout(cfg config.Config) (campaignassurancegate.RolloutMode, error) {
	raw := strings.TrimSpace(cfg.CampaignAssuranceGateRolloutMode)
	if raw == "" {
		if cfg.CampaignAssuranceSendGateEnabled {
			return campaignassurancegate.RolloutBlock, nil
		}
		return campaignassurancegate.RolloutOff, nil
	}
	mode, err := campaignassurancegate.ParseRolloutMode(raw)
	if err != nil {
		return "", err
	}
	if cfg.CampaignAssuranceSendGateEnabled && mode != campaignassurancegate.RolloutBlock {
		return "", fmt.Errorf(
			"POSTWAVE_ENABLE_CAMPAIGN_ASSURANCE_SEND_GATE=true conflicts with POSTWAVE_CAMPAIGN_ASSURANCE_GATE_ROLLOUT=%s; use block or remove the legacy flag",
			mode,
		)
	}
	return mode, nil
}

func initializeCampaignAssuranceGateConvergence(
	pool *db.Pool,
	rawMode string,
	registerer prometheus.Registerer,
) (campaignAssuranceGateConvergence, error) {
	mode, err := campaignassurancegate.ParseRolloutMode(rawMode)
	if err != nil {
		return campaignAssuranceGateConvergence{}, err
	}
	if mode == campaignassurancegate.RolloutOff {
		return campaignAssuranceGateConvergence{}, nil
	}
	if pool == nil {
		return campaignAssuranceGateConvergence{}, errors.New("campaign assurance gate rollout requires a database")
	}
	observer, err := campaignassurancegate.NewPrometheusObserver(registerer)
	if err != nil {
		return campaignAssuranceGateConvergence{}, err
	}
	repository := campaignassurance.NewRepo(pool)
	return campaignAssuranceGateConvergence{Rollout: &campaignassurancegate.Rollout{
		Gate: &campaignassurancegate.Gate{Store: repository}, Mode: mode, Observer: observer,
	}}, nil
}

func (c campaignAssuranceGateConvergence) applyCampaignQueue(deps *campaigns.Deps) {
	if deps == nil || c.Rollout == nil {
		return
	}
	deps.AssuranceGate = c.Rollout
	deps.AssuranceGateEnabled = c.Rollout.RolloutMode() != campaignassurancegate.RolloutOff
}

func (c campaignAssuranceGateConvergence) applyPreSend(deps *presend.Deps) {
	if deps == nil || c.Rollout == nil {
		return
	}
	deps.CampaignAssurance = c.Rollout
}

func (c campaignAssuranceGateConvergence) blocksDispatch() bool {
	return c.Rollout != nil && c.Rollout.RolloutMode() == campaignassurancegate.RolloutBlock
}
