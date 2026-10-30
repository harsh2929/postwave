// SPDX-License-Identifier: MIT

package drip

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceDrip, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceDrip, "drip_csv_export")
}
