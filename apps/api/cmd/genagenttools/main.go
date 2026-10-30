// SPDX-License-Identifier: AGPL-3.0-only
//
// Command genagenttools emits (or, with -check, verifies) the canonical
// agent-tool manifest from the in-code registry. It is the source of the
// `audit:tools` drift gate: the registry is the single source of truth,
// and the checked-in manifest must always reflect it.
//
//	go run ./cmd/genagenttools           # regenerate the golden manifest
//	go run ./cmd/genagenttools -check    # CI gate: fail on drift
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"

	"github.com/postwave/postwave/apps/api/internal/mcp"
)

func main() {
	check := flag.Bool("check", false, "verify the golden manifest matches the registry (exit non-zero on drift)")
	out := flag.String("out", "internal/agenttools/native_manifest.json", "manifest path, relative to apps/api")
	flag.Parse()

	// Building the registry also runs Registry().Validate(), so a
	// mis-declared tool fails here too. Nil pool is fine: no handler runs.
	reg := (&mcp.Deps{}).Registry()
	got, err := reg.ManifestJSON()
	if err != nil {
		fmt.Fprintln(os.Stderr, "genagenttools: marshal manifest:", err)
		os.Exit(1)
	}

	if *check {
		want, err := os.ReadFile(*out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "genagenttools: cannot read %s (%v).\nRun `go run ./cmd/genagenttools` to generate it.\n", *out, err)
			os.Exit(1)
		}
		if !bytes.Equal(got, want) {
			fmt.Fprintf(os.Stderr, "genagenttools: %s is stale — the tool registry changed.\nRun `go run ./cmd/genagenttools` and commit the result.\n", *out)
			os.Exit(1)
		}
		fmt.Printf("genagenttools: manifest up to date (%d tools)\n", reg.Len())
		return
	}

	if err := os.WriteFile(*out, got, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "genagenttools: write manifest:", err)
		os.Exit(1)
	}
	fmt.Printf("genagenttools: wrote %s (%d tools)\n", *out, reg.Len())
}
