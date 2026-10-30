// SPDX-License-Identifier: MIT

package campaignmonitor

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceCampaignMonitor, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceCampaignMonitor, "campaign_monitor_csv_export")
}
