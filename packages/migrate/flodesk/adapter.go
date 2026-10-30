// SPDX-License-Identifier: MIT

package flodesk

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceFlodesk, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceFlodesk, "flodesk_csv_export")
}
