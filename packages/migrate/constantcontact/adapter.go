// SPDX-License-Identifier: MIT

package constantcontact

import (
	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	"github.com/postwave/migrate/exportcsv"
)

func init() {
	adapter.Register(canonical.SourceConstantContact, func() adapter.Adapter { return New() })
}

func New() *exportcsv.Adapter {
	return exportcsv.New(canonical.SourceConstantContact, "constant_contact_csv_export")
}
