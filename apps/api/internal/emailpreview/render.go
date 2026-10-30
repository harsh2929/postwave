// SPDX-License-Identifier: AGPL-3.0-only
//
// Package emailpreview turns an MJML+vars pair into per-client HTML
// approximations. The point isn't pixel-perfection — that requires a paid
// service like Litmus. The point is to catch the obvious "this is going to
// look terrible in Outlook" issues *before* a campaign ships, by applying
// a curated set of well-documented client quirks to a single rendered HTML.
//
// Pipeline:
//  1. Render MJML → HTML (mjml CLI in production; regex stub fallback in dev/test).
//  2. Substitute {{var_name}} placeholders.
//  3. Apply per-client transforms (clients.go).
//
// Each step records warnings so the UI can surface "we used the stub
// renderer" in dev/test or "the body had a <script> tag" rather than
// silently producing surprising output.
package emailpreview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// renderTimeout caps how long we wait for the mjml CLI before giving up.
// 5s is generous for a single email but tight enough that a hung CLI
// doesn't wedge the request.
const renderTimeout = 5 * time.Second

// maxMJMLBytes guards the renderer itself; the HTTP layer also enforces
// a body limit but a defense-in-depth check here means library callers
// can't accidentally feed a 50MB file in.
const maxMJMLBytes = 1 << 20 // 1 MiB

// Renderer labels surfaced in the HTTP response so the client can tell
// the operator which fidelity level produced the preview (A31).
const (
	// RendererMJML — the real mjml CLI converted MJML input.
	RendererMJML = "mjml"
	// RendererEngine — the Listmonk-fork engine rendered HTML input via
	// POST /api/templates/preview (same pipeline as campaign sends).
	RendererEngine = "engine"
	// RendererFallback — the local pass-through/regex stub. Explicitly
	// labelled so the desktop can badge the preview as approximate.
	RendererFallback = "fallback"
)

// reMJTag detects MJML input: an <mjml> root or any <mj-*> element.
var reMJTag = regexp.MustCompile(`(?i)<mj(ml[\s>]|-[a-z])`)

func looksLikeMJML(s string) bool { return reMJTag.MatchString(s) }

// RenderMJML converts MJML to HTML and substitutes {{var}} placeholders.
// Compatibility wrapper around renderPipeline with no engine wired —
// see renderPipeline for the full strategy.
//
// Returns (html, warnings, error). Warnings are non-fatal observations
// (e.g. "stub renderer used", "1 unmatched template variable").
func RenderMJML(ctx context.Context, mjml string, vars map[string]string) (string, []string, error) {
	html, _, warnings, err := renderPipeline(ctx, nil, mjml, vars)
	return html, warnings, err
}

// renderPipeline is the one-shot input → HTML transform.
//
// Strategy (A31):
//   - {{var}} placeholders are substituted FIRST, on the raw input, so
//     the engine's Go-template compiler never sees our var syntax.
//   - MJML input → the `mjml` CLI (lookpath, or MJML_BIN override).
//     That's the only way to get true MJML fidelity. If the CLI is
//     missing in dev/test we fall back to the regex stub (renderer =
//     "fallback"); in production CLI failure stays fatal — a customer-
//     facing MJML preview must never silently downgrade.
//   - Plain-HTML input → the engine renderer (upstream Listmonk over HTTP,
//     the same template pipeline campaign sends use). When the engine
//     is unconfigured or unreachable we keep the historical pass-
//     through behaviour, but label it renderer = "fallback" and attach
//     a warning so the client can badge it.
//
// Returns (html, renderer, warnings, error). renderer is one of the
// Renderer* constants above.

// ErrInvalidInput marks a caller mistake rather than a server failure.
//
// Without it a handler cannot tell "you sent an empty body" from "the database
// is down", so every rejection here surfaced as a 500: the client could not
// show the operator what to fix, and the error budget counted user typos as
// outages. Follows the convention already in internal/audiences.
var ErrInvalidInput = errors.New("emailpreview: invalid input")

func renderPipeline(ctx context.Context, engine *EngineRenderer, input string, vars map[string]string) (string, string, []string, error) {
	if len(input) > maxMJMLBytes {
		return "", "", nil, fmt.Errorf("%w: mjml exceeds %d bytes", ErrInvalidInput, maxMJMLBytes)
	}
	input = strings.TrimSpace(input)
	if input == "" {
		return "", "", nil, fmt.Errorf("%w: empty mjml", ErrInvalidInput)
	}

	var warnings []string

	// Cheap content-safety hint. We do NOT strip — that's the caller's
	// job; we just flag for the UI so reviewers can decide.
	if strings.Contains(strings.ToLower(input), "<script") {
		warnings = append(warnings, "input contains <script>; most clients strip it but flag for review")
	}

	// Vars go in before rendering: leftover {{name}} actions would trip
	// the engine's template compiler, and the mjml CLI passes them
	// through either way, so substituting up front is behaviour-neutral
	// for the CLI path and required for the engine path.
	input, missing := substituteVars(input, vars)
	for _, m := range missing {
		warnings = append(warnings, "unmatched template variable: "+m)
	}

	var html, renderer string
	if looksLikeMJML(input) {
		out, used, err := tryMJMLCLI(ctx, input)
		if err != nil {
			if isProductionRuntime() {
				return "", "", warnings, fmt.Errorf("emailpreview: mjml CLI unavailable in production: %w", err)
			}
			// CLI failure is recoverable — fall back to the stub renderer
			// rather than failing the request in dev/test. Flag so the UI shows it.
			warnings = append(warnings, "mjml CLI failed ("+err.Error()+"); using stub renderer")
			out = stubRenderMJML(input)
			used = "stub"
		}
		html, renderer = out, RendererMJML
		if used == "stub" {
			renderer = RendererFallback
			warnings = append(warnings, "stub renderer used; install mjml CLI for production fidelity")
		}
	} else {
		// Plain HTML → real rendering via the engine when available.
		if engine != nil {
			out, err := engine.Render(ctx, input)
			if err == nil {
				return out, RendererEngine, warnings, nil
			}
			warnings = append(warnings, "engine renderer failed ("+err.Error()+"); using pass-through fallback")
		} else {
			warnings = append(warnings, "engine renderer not configured; using pass-through fallback")
		}
		html, renderer = passthroughHTML(input), RendererFallback
	}

	return html, renderer, warnings, nil
}

// reHTMLRoot — does the input already carry its own <html> document
// skeleton? The per-client transforms anchor on <html>/<body>.
var reHTMLRoot = regexp.MustCompile(`(?i)<html[\s>]`)

// passthroughHTML is the explicit fallback for plain-HTML input: the
// content is passed through untouched, wrapped in a minimal document
// skeleton only when it doesn't already have one.
func passthroughHTML(input string) string {
	if reHTMLRoot.MatchString(input) {
		return input
	}
	return `<!doctype html><html><head><meta charset="utf-8"><title>Email preview</title></head><body>` +
		input +
		`</body></html>`
}

// tryMJMLCLI invokes the mjml binary if available. Returns ("", "", err)
// when the CLI is not on PATH (so the caller can fall back without
// reporting a misleading error).
func tryMJMLCLI(ctx context.Context, mjml string) (string, string, error) {
	bin := os.Getenv("MJML_BIN")
	if bin == "" {
		var err error
		bin, err = exec.LookPath("mjml")
		if err != nil {
			// Not an "error" in the user-visible sense; return a sentinel
			// so the caller falls back without escalating.
			return "", "", errNoCLI
		}
	}

	cctx, cancel := context.WithTimeout(ctx, renderTimeout)
	defer cancel()

	// `mjml -i` reads MJML from stdin and writes HTML to stdout. -s would
	// suppress the validation header but we want stderr captured anyway,
	// so we just use stdin streaming.
	cmd := exec.CommandContext(cctx, bin, "-i")
	cmd.Stdin = strings.NewReader(mjml)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", "", errors.New(msg)
	}
	return stdout.String(), "cli", nil
}

// errNoCLI is the sentinel for "mjml not on PATH" so callers can branch
// cleanly without parsing an error string.
var errNoCLI = errors.New("mjml CLI not found")

func isProductionRuntime() bool {
	for _, key := range []string{"POSTWAVE_ENV", "ENVIRONMENT", "NODE_ENV"} {
		v := strings.TrimSpace(os.Getenv(key))
		if strings.EqualFold(v, "production") || strings.EqualFold(v, "prod") {
			return true
		}
	}
	return false
}

// stubRenderMJML is a brutally simple regex-based MJML→HTML transform.
//
// It's intentionally NOT a real MJML implementation. It exists so the
// package compiles + tests pass + dev-mode preview shows *something*
// reasonable when the user hasn't installed Node. Production should
// always have the CLI installed.
//
// Transforms applied (order matters because some are nested):
//   - <mjml>, <mj-body>, <mj-head>, <mj-attributes>, <mj-style> wrappers
//     are unwrapped/dropped.
//   - <mj-section>     → <table role="presentation" width="100%"><tr>
//   - </mj-section>    → </tr></table>
//   - <mj-column>      → <td>
//   - </mj-column>     → </td>
//   - <mj-text ...>    → <p ...>
//   - </mj-text>       → </p>
//   - <mj-button ...>  → <a class="mj-button" ...>
//   - </mj-button>     → </a>
//   - <mj-image src="x" ...> → <img src="x" ... />
//   - <mj-divider />   → <hr/>
//   - <mj-spacer />    → dropped
//
// Anything we don't recognize is left in place and will likely render
// as text — fine for a stub.
func stubRenderMJML(mjml string) string {
	out := mjml

	// Strip head/style blocks; the stub doesn't try to honor them.
	out = reHead.ReplaceAllString(out, "")
	// Unwrap mjml/mj-body — preserve inner content.
	out = reMjml.ReplaceAllString(out, "$1")
	out = reBody.ReplaceAllString(out, "$1")

	out = reSectionOpen.ReplaceAllString(out, `<table role="presentation" width="100%" border="0" cellpadding="0" cellspacing="0"><tr>`)
	out = reSectionClose.ReplaceAllString(out, `</tr></table>`)
	out = reColumnOpen.ReplaceAllString(out, `<td>`)
	out = reColumnClose.ReplaceAllString(out, `</td>`)
	out = reTextOpen.ReplaceAllString(out, `<p>`)
	out = reTextClose.ReplaceAllString(out, `</p>`)
	out = reButtonOpen.ReplaceAllString(out, `<a class="mj-button">`)
	out = reButtonClose.ReplaceAllString(out, `</a>`)
	out = reImage.ReplaceAllString(out, `<img src="$1" alt="" />`)
	out = reDivider.ReplaceAllString(out, `<hr/>`)
	out = reSpacer.ReplaceAllString(out, ``)

	// Wrap with a minimal HTML skeleton so client transforms have <html>
	// and <body> to anchor against.
	return `<!doctype html><html><head><meta charset="utf-8"><title>Email preview</title></head><body>` +
		out +
		`</body></html>`
}

var (
	reHead         = regexp.MustCompile(`(?is)<mj-head[^>]*>.*?</mj-head>`)
	reMjml         = regexp.MustCompile(`(?is)<mjml[^>]*>(.*?)</mjml>`)
	reBody         = regexp.MustCompile(`(?is)<mj-body[^>]*>(.*?)</mj-body>`)
	reSectionOpen  = regexp.MustCompile(`(?is)<mj-section[^>]*>`)
	reSectionClose = regexp.MustCompile(`(?is)</mj-section>`)
	reColumnOpen   = regexp.MustCompile(`(?is)<mj-column[^>]*>`)
	reColumnClose  = regexp.MustCompile(`(?is)</mj-column>`)
	reTextOpen     = regexp.MustCompile(`(?is)<mj-text[^>]*>`)
	reTextClose    = regexp.MustCompile(`(?is)</mj-text>`)
	reButtonOpen   = regexp.MustCompile(`(?is)<mj-button[^>]*>`)
	reButtonClose  = regexp.MustCompile(`(?is)</mj-button>`)
	reImage        = regexp.MustCompile(`(?is)<mj-image[^>]*\bsrc="([^"]*)"[^>]*/?>`)
	reDivider      = regexp.MustCompile(`(?is)<mj-divider[^>]*/?>`)
	reSpacer       = regexp.MustCompile(`(?is)<mj-spacer[^>]*/?>`)
	reVar          = regexp.MustCompile(`\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}`)
)

// substituteVars replaces every {{name}} occurrence using vars[name]. If
// a name is missing from vars, the placeholder is replaced with an empty
// string (not left in place — that surfaces in inboxes as literal
// "{{firstname}}" which is worse than blank), and the name is returned
// in `missing` so the caller can warn.
func substituteVars(html string, vars map[string]string) (string, []string) {
	if vars == nil {
		vars = map[string]string{}
	}
	missingSet := map[string]struct{}{}
	out := reVar.ReplaceAllStringFunc(html, func(match string) string {
		m := reVar.FindStringSubmatch(match)
		if len(m) < 2 {
			return ""
		}
		name := m[1]
		if v, ok := vars[name]; ok {
			return v
		}
		missingSet[name] = struct{}{}
		return ""
	})
	missing := make([]string, 0, len(missingSet))
	for k := range missingSet {
		missing = append(missing, k)
	}
	return out, missing
}
