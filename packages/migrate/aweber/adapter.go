// SPDX-License-Identifier: MIT

package aweber

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceAWeber, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceAWeber, "aweber_csv_export")
}
