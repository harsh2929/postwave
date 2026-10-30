// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import "context"

// Preview is the four per-client HTML approximations + any warnings the
// renderer collected. The HTML strings are ready for an iframe srcDoc.
// Renderer names which pipeline produced the base HTML — one of
// RendererMJML / RendererEngine / RendererFallback — so the client can
// badge approximate previews (A31).
type Preview struct {
	GmailHTML   string   `json:"gmail"`
	OutlookHTML string   `json:"outlook"`
	AppleHTML   string   `json:"apple"`
	DarkHTML    string   `json:"dark"`
	Warnings    []string `json:"warnings"`
	Renderer    string   `json:"renderer"`
}

// BuildPreview is the engine-less pipeline kept for callers/tests that
// don't have an EngineRenderer at hand. Plain-HTML input is labelled
// RendererFallback. See BuildPreviewWithEngine.
func BuildPreview(ctx context.Context, mjml string, vars map[string]string) (*Preview, error) {
	return BuildPreviewWithEngine(ctx, nil, mjml, vars)
}

// BuildPreviewWithEngine is the one-shot pipeline used by the HTTP
// handler. It renders the input once (mjml CLI for MJML, the engine for
// plain HTML, pass-through fallback otherwise), then applies each
// per-client transform to the result. Each transform is a pure function
// so we don't need to clone the input — they each produce a new string.
//
// If the render step fails (bad MJML, CLI error not recoverable to the
// stub), the error is returned and no Preview is produced. Renderer
// warnings are propagated to Preview.Warnings.
func BuildPreviewWithEngine(ctx context.Context, engine *EngineRenderer, input string, vars map[string]string) (*Preview, error) {
	html, renderer, warnings, err := renderPipeline(ctx, engine, input, vars)
	if err != nil {
		return nil, err
	}
	return &Preview{
		GmailHTML:   ApplyGmailWeb(html),
		OutlookHTML: ApplyOutlookDesktop(html),
		AppleHTML:   ApplyAppleMail(html),
		DarkHTML:    ApplyDarkMode(html),
		Warnings:    warnings,
		Renderer:    renderer,
	}, nil
}
