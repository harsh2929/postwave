// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_import

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// subscriberImportHTTPError exposes only a closed failure class to the shared
// logger. Its synthetic url.Error preserves WriteInternal's existing 502
// response for outbound transport failures without retaining an upstream URL,
// operation, credential, row, or recipient from the source error.
type subscriberImportHTTPError struct {
	class    string
	upstream bool
}

func (e subscriberImportHTTPError) Error() string { return e.class }

func (e subscriberImportHTTPError) Unwrap() error {
	if !e.upstream {
		return nil
	}
	return &url.Error{Op: "dependency", Err: errors.New(e.class)}
}

// writeSubscriberImportInternal is the only subscriber-import HTTP path
// allowed to call httperror.WriteInternal. It preserves the shared generic
// response and request-id behavior while preventing database, storage,
// verification-provider, CSV-row, tenant, or recipient details from entering
// process logs.
func writeSubscriberImportInternal(
	w http.ResponseWriter,
	logger *slog.Logger,
	err error,
	ctx context.Context,
) {
	var upstream *url.Error
	writeErr := subscriberImportHTTPError{
		class:    subscriberImportLogErrorClass(err),
		upstream: err != nil && errors.As(err, &upstream),
	}
	httperror.WriteInternal(w, logger, writeErr, ctx)
}
