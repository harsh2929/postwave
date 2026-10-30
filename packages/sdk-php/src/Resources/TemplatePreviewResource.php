<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * TemplatePreviewResource renders an MJML/HTML template (with the
 * lightweight conditional-block syntax) against a vars map. Mirrors
 * packages/sdk-ts/src/resources/template-preview.ts.
 */
final class TemplatePreviewResource extends Resource
{
    /**
     * @param array{template: string, vars?: array<string, mixed>} $input
     * @return array<string, mixed>
     */
    public function preview(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/templates/preview', [
            'template' => $input['template'] ?? '',
            'vars' => $input['vars'] ?? [],
        ]);
        return is_array($out) ? $out : [];
    }

    /**
     * Alias for preview() matching the MCP tool name.
     *
     * @param array{template: string, vars?: array<string, mixed>} $input
     * @return array<string, mixed>
     */
    public function render(array $input): array
    {
        return $this->preview($input);
    }
}
