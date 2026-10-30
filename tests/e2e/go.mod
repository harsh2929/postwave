// Standalone Go module for the end-to-end test suite.
//
// Why a separate module instead of joining go.work:
//   - The e2e suite drives the running stack via HTTP only — it must
//     not import any apps/api or services/* package, otherwise we'd
//     accidentally lock production code to test-only types.
//   - Keeping it out of go.work means `go test ./...` inside the main
//     workspace doesn't try to spin up Docker.
//   - Dependencies stay minimal: stdlib + nothing else for now. As
//     journeys are filled in we may add a YAML lib for fixtures, but
//     the harness today uses only net/http + encoding/json.
//
// Run it from the repo root via tests/e2e/run.sh, or from this dir
// with `go test -v ./...`.

module github.com/postwave/postwave/tests/e2e

go 1.24

toolchain go1.26.8
