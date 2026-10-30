package commerce

import (
	"strings"
	"time"
)

func decorateIntegrationSyncState(in *Integration, now time.Time) {
	if in == nil {
		return
	}
	in.SyncState = integrationSyncState(in.SyncCursor, now)
}

func integrationSyncState(cursor string, now time.Time) *IntegrationSyncState {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return nil
	}
	if state, ok, err := decodeShopifyBulkOperationCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && shopifyBulkOperationCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "shopify_bulk",
			Mode:          "async_bulk_operation",
			Object:        state.Object,
			OperationID:   state.OperationID,
			LineOffset:    state.LineOffset,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if state, err := decodeShopifyBackfillCursor(cursor); err == nil {
		out := &IntegrationSyncState{
			CursorKind: "shopify_cursor",
			Mode:       "cursor_backfill",
			Object:     state.Object,
			Complete:   state.Object == "complete",
		}
		if cursor == shopifyBackfillCursorComplete {
			out.CursorKind = "shopify_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeWooCommerceRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && wooCommerceRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "woocommerce_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == woocommerceCursorComplete || strings.HasPrefix(cursor, woocommerceCursorPrefix) {
		state, err := decodeWooCommerceBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "woocommerce_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			Complete:   state.Object == "complete",
		}
		if cursor == woocommerceCursorComplete {
			out.CursorKind = "woocommerce_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeBigCommerceRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && bigCommerceRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "bigcommerce_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == bigCommerceCursorComplete || strings.HasPrefix(cursor, bigCommerceCursorPrefix) {
		state, err := decodeBigCommerceBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "bigcommerce_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			Complete:   state.Object == "complete",
		}
		if cursor == bigCommerceCursorComplete {
			out.CursorKind = "bigcommerce_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeStripeRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && stripeRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "stripe_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == stripeCursorComplete || strings.HasPrefix(cursor, stripeCursorPrefix) {
		state, err := decodeStripeBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "stripe_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			Complete:   state.Object == "complete",
		}
		if cursor == stripeCursorComplete {
			out.CursorKind = "stripe_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeSquareRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && squareRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "square_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == squareCursorComplete || strings.HasPrefix(cursor, squareCursorPrefix) {
		state, err := decodeSquareBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "square_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			Complete:   state.Object == "complete",
		}
		if cursor == squareCursorComplete {
			out.CursorKind = "square_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodePayPalRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && payPalRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "paypal_retry",
			Mode:          "reporting_backfill",
			Object:        state.Object,
			LineOffset:    int64(state.Page),
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == payPalCursorComplete || strings.HasPrefix(cursor, payPalCursorPrefix) {
		state, err := decodePayPalBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "paypal_cursor",
			Mode:       "reporting_backfill",
			Object:     state.Object,
			LineOffset: int64(state.Page),
			Complete:   state.Object == "complete",
		}
		if cursor == payPalCursorComplete {
			out.CursorKind = "paypal_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeRazorpayRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && razorpayRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "razorpay_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			LineOffset:    int64(state.Skip),
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == razorpayCursorComplete || strings.HasPrefix(cursor, razorpayCursorPrefix) {
		state, err := decodeRazorpayBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "razorpay_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			LineOffset: int64(state.Skip),
			Complete:   state.Object == "complete",
		}
		if cursor == razorpayCursorComplete {
			out.CursorKind = "razorpay_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeAdobeCommerceRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && adobeCommerceRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "adobe_commerce_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			LineOffset:    int64(state.Page),
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == adobeCommerceCursorComplete || strings.HasPrefix(cursor, adobeCommerceCursorPrefix) {
		state, err := decodeAdobeCommerceBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind: "adobe_commerce_cursor",
			Mode:       "rest_backfill",
			Object:     state.Object,
			LineOffset: int64(state.Page),
			Complete:   state.Object == "complete",
		}
		if cursor == adobeCommerceCursorComplete {
			out.CursorKind = "adobe_commerce_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeWixStoresRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && wixStoresRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "wix_stores_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			OperationID:   state.ProviderCursor,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == wixStoresCursorComplete || strings.HasPrefix(cursor, wixStoresCursorPrefix) {
		state, err := decodeWixStoresBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind:  "wix_stores_cursor",
			Mode:        "rest_backfill",
			Object:      state.Object,
			OperationID: state.Cursor,
			Complete:    state.Object == "complete",
		}
		if cursor == wixStoresCursorComplete {
			out.CursorKind = "wix_stores_complete"
			out.Mode = "complete"
		}
		return out
	}
	if state, ok, err := decodeSquarespaceRetryCursor(cursor); err == nil && ok {
		retryDue := state.Attempts > 0 && squarespaceRetryCursorDue(state, now)
		out := &IntegrationSyncState{
			CursorKind:    "squarespace_retry",
			Mode:          "rest_backfill",
			Object:        state.Object,
			OperationID:   state.ProviderCursor,
			Attempts:      state.Attempts,
			NextAttemptAt: state.NextAttemptAt,
			LastStatus:    state.LastStatus,
			LastError:     state.LastError,
			RetryDue:      retryDue,
		}
		if out.NextAttemptAt != "" && !out.RetryDue {
			if at, err := time.Parse(time.RFC3339, out.NextAttemptAt); err == nil {
				wait := at.Sub(now.UTC())
				if wait > 0 {
					out.RetryWaitSeconds = int64(wait.Seconds())
				}
			}
		}
		return out
	}
	if cursor == squarespaceCursorComplete || strings.HasPrefix(cursor, squarespaceCursorPrefix) {
		state, err := decodeSquarespaceBackfillCursor(cursor)
		if err != nil {
			return &IntegrationSyncState{CursorKind: "unknown"}
		}
		out := &IntegrationSyncState{
			CursorKind:  "squarespace_cursor",
			Mode:        "rest_backfill",
			Object:      state.Object,
			OperationID: state.Cursor,
			Complete:    state.Object == "complete",
		}
		if cursor == squarespaceCursorComplete {
			out.CursorKind = "squarespace_complete"
			out.Mode = "complete"
		}
		return out
	}
	if strings.HasPrefix(cursor, "sync-") {
		return &IntegrationSyncState{CursorKind: "legacy", Mode: "legacy_backfill"}
	}
	return &IntegrationSyncState{CursorKind: "unknown"}
}

func decorateIntegrationListSyncState(items []Integration, now time.Time) []Integration {
	for idx := range items {
		decorateIntegrationSyncState(&items[idx], now)
	}
	return items
}
