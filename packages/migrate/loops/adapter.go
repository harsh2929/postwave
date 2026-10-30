// SPDX-License-Identifier: MIT

package loops

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceLoops, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceLoops, "loops_csv_export")
}
