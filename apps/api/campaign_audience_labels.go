// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"github.com/postwave/postwave/packages/runtime/tenantengine"
	"strconv"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/campaigns"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/lists"
)

// campaignListOwnership proves a tenant owns an engine list id before the
// shared engine is asked about it. lists.Repo satisfies it.
type campaignListOwnership interface {
	GetListUUIDByBigintID(ctx context.Context, tenantID string, bigintID int64) (string, error)
}

// campaignListEngine reads a list's name from the engine. *listmonk.Client
// satisfies it.
type campaignListEngine interface {
	GetList(ctx context.Context, id int64) (*listmonk.List, error)
}

// campaignListNamer gives the campaign checklist and send review the name of
// a list audience. List names live only in the engine (Listmonk), which every
// tenant shares, so the id is first proven to belong to the tenant through
// list_id_map: a campaign row can never cause another tenant's list name to be
// read back to it.
type campaignListNamer struct {
	ownership campaignListOwnership
	engine    campaignListEngine
}

func newCampaignListNamer(pool *db.Pool, engine *listmonk.Client) campaigns.ListNamer {
	if engine == nil {
		return nil
	}
	return campaignListNamer{ownership: &lists.Repo{Pool: pool}, engine: engine}
}

// ListName implements campaigns.ListNamer. listID is the engine id stored on
// campaigns.audience_list_id.
func (n campaignListNamer) ListName(ctx context.Context, tenantID, listID string) (string, error) {
	ctx = tenantengine.WithTenant(ctx, tenantID)
	engineID, parseErr := strconv.ParseInt(strings.TrimSpace(listID), 10, 64)
	if parseErr != nil || engineID <= 0 {
		return "", errors.New("campaign list name: list id is not an engine id")
	}
	if _, err := n.ownership.GetListUUIDByBigintID(ctx, tenantID, engineID); err != nil {
		return "", err
	}
	list, err := n.engine.GetList(ctx, engineID)
	if err != nil {
		return "", err
	}
	return list.Name, nil
}
