// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/postwave/postwave/apps/api/internal/apikeycalls"
	"github.com/postwave/postwave/apps/api/internal/ops"
	"github.com/postwave/postwave/apps/api/internal/safego"
)

// serveUntilShutdown starts the configured HTTP server, waits for
// SIGINT/SIGTERM or a listener failure, then performs the ordered graceful
// shutdown that used to live at the end of run(). The cancel funcs are run()'s
// background-worker contexts.
func serveUntilShutdown(logger *slog.Logger, srv *http.Server, opsFleet *ops.Fleet, trustOpsCancel context.CancelFunc, outboxCancel context.CancelFunc, janitorCancel context.CancelFunc, apiKeyCallsRecorderOuter *apikeycalls.Recorder) error {
	errCh := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("listen: %w", err)
			return
		}
		errCh <- nil
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-stop:
		logger.Info("shutdown signal received", "signal", sig.String())
		// Past this point every worker exit is expected. Without this, a
		// replica on its way out would write RED to the shared board on
		// behalf of the replicas still serving traffic.
		opsFleet.BeginShutdown()
	case err := <-errCh:
		if err != nil {
			return err
		}
		return nil
	}

	// Ordered graceful shutdown:
	//
	//   1. Cancel every background-worker context (trustOps, outbox,
	//      janitor) BEFORE draining HTTP. Workers see ctx.Done and
	//      tear down their tickers / DB sessions while inbound
	//      requests continue to be served, so we don't log "context
	//      cancelled" mid-request.
	//   2. srv.Shutdown(10s) drains in-flight HTTP requests.
	//   3. workersWG.Wait(15s) via safego.Wait blocks until every
	//      safego.Go-spawned goroutine has exited (or the timeout
	//      elapses). This is the step that was missing — without it,
	//      pool.Close() ran while workers were mid-query.
	//   4. Deferred pool.Close() / tracing shutdown / sentry flush
	//      then fire in LIFO order with no live workers attached.
	trustOpsCancel()
	outboxCancel()
	janitorCancel()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}

	// Drain the bounded API-key-calls recorder buffer BEFORE we wait on
	// safego: Close() stops accepting new events and blocks (bounded
	// by RecorderShutdownTimeout) for the worker pool to flush the
	// in-flight tail. Putting it here — after HTTP is drained, before
	// pool.Close — guarantees no observability row is lost to the
	// shutdown race while still keeping the overall shutdown bounded.
	apiKeyCallsRecorderOuter.Close()

	if !safego.Wait(15 * time.Second) {
		logger.Warn("graceful shutdown: workers did not exit within 15s; proceeding with pool close anyway")
	} else {
		logger.Info("graceful shutdown: all background workers exited cleanly")
	}

	logger.Info("server stopped cleanly")
	return nil
}
