// SPDX-License-Identifier: AGPL-3.0-only

// Package snowflakeminicore stops the Snowflake driver from loading its
// native "minicore" library when a process starts.
//
// github.com/snowflakedb/gosnowflake (v1.19) starts a goroutine from its
// package init. That goroutine writes an embedded shared library to a new
// directory under $TMPDIR (falling back to the user's cache directory, then to
// the working directory) and dlopens it. The library has no part in a
// connection: the driver only copies its version string into the CORE_VERSION
// field of the login request's client-environment telemetry. Every binary that
// links the driver pays for the load, whether or not it ever opens a Snowflake
// connection. That includes the API server, the campaign-assurance worker and
// the test binary of every package that links internal/warehouse or
// internal/zerocopy_triggers.
//
// The dlopen only happens where cgo is enabled, which includes every
// `go test -race` binary. On macOS the kernel holds the load of a freshly
// written library until syspolicyd has assessed it. During a full parallel
// test run that took up to about 40 s. For the same period the process's
// first os/user.Current call, which pgx's ParseConfig makes inside db.New,
// stayed blocked in getpwuid_r. A 10 s db.New deadline expired before any
// socket was opened, and internal/warehouse failed.
//
// The loader also leaks a directory, and that part reaches production.
// Production images are built with CGO_ENABLED=0 and are statically linked,
// so there the driver refuses the load. It refuses only after the goroutine
// has created its directory with os.MkdirTemp: "gosnowflake-cgo" followed by
// random digits, in os.TempDir(). The goroutine removes that directory only
// after it has written the library into it and the load attempt has returned.
// Every earlier exit leaves the directory behind, and a static binary always
// takes one: it finds no dynamic linker and returns before it writes anything.
// So every start of a production process leaves one empty directory in its
// temp dir, and nothing ever removes it. A cgo binary that exits before its
// load attempt returns, as a short test binary on a loaded host does, leaves
// the directory with its copy of the library inside. After three days of test
// runs, one developer machine's temp dir held 3,536 such directories, 3,520 of
// them with the library still in them.
//
// With the loader off, the goroutine never starts. No directory is created and
// nothing is loaded, in every build. Snowflake connections do not change.
//
// The driver reads SF_DISABLE_MINICORE once, in its own init, so the default
// must be in the environment before that init runs. A package's init always
// runs after the inits of the packages it imports, so the package that
// imports the driver cannot set the default itself. It imports this package
// as well, and the language guarantees that this package is initialized
// first. Go initializes one package at a time: of the packages whose imports
// are all initialized, it takes the one whose import path sorts first. This
// package imports only "os", which the driver also imports, so it is never
// ready later than the driver. Its import path sorts before
// github.com/snowflakedb/, so when both are ready it goes first. That holds in
// any binary that links both, whichever package imports this one. Each package
// whose code imports the driver proves the order on its own test binary with
// snowflakeminicoretest.RequireLoaderOff.
//
// So every file that imports the driver imports this package too, right next
// to it:
//
//	import (
//		_ "github.com/postwave/postwave/apps/api/internal/snowflakeminicore"
//		"github.com/snowflakedb/gosnowflake"
//	)
//
// One unguarded importer is enough to start the loader in every binary that
// links it. That is how internal/zerocopy_triggers kept the loader on after
// internal/warehouse had been fixed. TestEveryDriverImportComesWithTheGuard
// reads every Go file in this module and fails when:
//
//   - a file imports the driver without this package;
//   - a package's tests alone import the driver and none of its files imports
//     this package (one of those test files must);
//   - a package whose code imports the driver has a test file that imports
//     this package, which would let its order check pass after the import in
//     the code was deleted; or
//   - a package whose code imports the driver has no test file that imports
//     snowflakeminicoretest, so nothing checks the order on its binary.
//
// A module other than apps/api cannot import this package; one that links the
// driver needs its own copy.
//
// An operator who sets SF_DISABLE_MINICORE to any non-empty value keeps that
// value. The driver interprets it as before.
//
// Keep the import list of this package to "os". Every added import is another
// package that must be initialized before this one, and the ordering argument
// above only holds while the driver imports all of them too.
package snowflakeminicore

import "os"

// Env is the variable that the driver reads, once, in its package init.
const Env = "SF_DISABLE_MINICORE"

func init() {
	// os.Setenv can fail only for a malformed name, and Env is a constant. If
	// it ever failed, the driver would keep its own default, which is how
	// every process behaved before this package existed. An init function
	// has no better place to report the failure.
	_ = applyDefault(os.LookupEnv, os.Setenv)
}

// applyDefault turns the minicore loader off unless an operator has already
// chosen a value. An empty value counts as unset. The driver would read an
// empty value as "load", and a blank line in an env file or a compose file is
// not a decision.
func applyDefault(lookup func(string) (string, bool), set func(string, string) error) error {
	if value, ok := lookup(Env); ok && value != "" {
		return nil
	}
	return set(Env, "true")
}
