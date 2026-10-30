// SPDX-License-Identifier: AGPL-3.0-only
package customfields

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

// chiURLParamImpl is a thin shim over chi.URLParam so the rest of the
// package doesn't need to import chi directly. Lets unit tests stub
// path params without spinning up a chi router.
func chiURLParamImpl(r *http.Request, key string) string {
	return chi.URLParam(r, key)
}
