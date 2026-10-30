<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Concrete visual newsletter templates, personal discovery state, and durable
 * generate/adapt design jobs.
 *
 * This is intentionally separate from TemplatesResource, which represents
 * voice/sequence templates.
 */
final class CampaignTemplatesResource extends Resource
{
    /** @param array<string, mixed> $params @return array<int, array<string, mixed>> */
    public function list(array $params = []): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/campaign-templates',
            null,
            self::searchQuery($params)
        );
        return is_array($out) ? $out : [];
    }

    /** @param array<string, mixed> $params @return array<string, mixed> */
    public function search(array $params = []): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/search',
            null,
            self::searchQuery($params)
        ));
    }

    /** @return array<string, mixed> */
    public function get(string $templateId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/' . rawurlencode($templateId)
        ));
    }

    /** @return array<string, mixed> */
    public function favorite(string $templateId): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/favorite'
        ));
    }

    /** @return array<string, mixed> */
    public function unfavorite(string $templateId): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/unfavorite'
        ));
    }

    /** @param array<int, string> $identifiers @return array<string, mixed> */
    public function compare(array $identifiers): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/compare',
            null,
            ['templates' => implode(',', $identifiers)]
        ));
    }

    /** @return array<string, mixed> */
    public function recordView(string $templateId): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/view'
        ));
    }

    /** @return array<string, mixed> */
    public function recent(?int $limit = null): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/recent',
            null,
            $limit === null ? [] : ['limit' => $limit]
        ));
    }

    /** @return array<string, mixed> */
    public function clearRecent(?string $templateId = null): array
    {
        $path = '/api/v1/campaign-templates/recent';
        if ($templateId !== null) {
            $path .= '/' . rawurlencode($templateId);
        }
        return self::arrayResult($this->client->request('DELETE', $path));
    }

    /** @return array<string, mixed> */
    public function listCollections(): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-collections'
        ));
    }

    /** @return array<string, mixed> */
    public function getCollection(string $collectionId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-collections/' . rawurlencode($collectionId)
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createCollection(array $input, string $idempotencyKey): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-collections',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @param array<string, mixed> $patch @return array<string, mixed> */
    public function updateCollection(
        string $collectionId,
        array $patch,
        string $ifMatch
    ): array {
        return self::arrayResult($this->client->request(
            'PATCH',
            '/api/v1/campaign-template-collections/' . rawurlencode($collectionId),
            $patch,
            [],
            ['If-Match' => self::discoveryIfMatch(
                $ifMatch,
                'campaign-template-collection',
                $collectionId
            )]
        ));
    }

    /** @param array<int, string> $templateIds @return array<string, mixed> */
    public function replaceCollectionItems(
        string $collectionId,
        array $templateIds,
        string $ifMatch
    ): array {
        return self::arrayResult($this->client->request(
            'PUT',
            '/api/v1/campaign-template-collections/' . rawurlencode($collectionId) . '/items',
            ['template_ids' => $templateIds],
            [],
            ['If-Match' => self::discoveryIfMatch(
                $ifMatch,
                'campaign-template-collection',
                $collectionId
            )]
        ));
    }

    /** @return array<string, mixed> */
    public function deleteCollection(string $collectionId, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'DELETE',
            '/api/v1/campaign-template-collections/' . rawurlencode($collectionId),
            null,
            [],
            ['If-Match' => self::discoveryIfMatch(
                $ifMatch,
                'campaign-template-collection',
                $collectionId
            )]
        ));
    }

    /** @return array<string, mixed> */
    public function listSavedSearches(): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-saved-searches'
        ));
    }

    /** @return array<string, mixed> */
    public function getSavedSearch(string $savedSearchId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-saved-searches/' . rawurlencode($savedSearchId)
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createSavedSearch(array $input, string $idempotencyKey): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-saved-searches',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @param array<string, mixed> $patch @return array<string, mixed> */
    public function updateSavedSearch(
        string $savedSearchId,
        array $patch,
        string $ifMatch
    ): array {
        return self::arrayResult($this->client->request(
            'PATCH',
            '/api/v1/campaign-template-saved-searches/' . rawurlencode($savedSearchId),
            $patch,
            [],
            ['If-Match' => self::discoveryIfMatch(
                $ifMatch,
                'campaign-template-saved-search',
                $savedSearchId
            )]
        ));
    }

    /** @return array<string, mixed> */
    public function deleteSavedSearch(string $savedSearchId, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'DELETE',
            '/api/v1/campaign-template-saved-searches/' . rawurlencode($savedSearchId),
            null,
            [],
            ['If-Match' => self::discoveryIfMatch(
                $ifMatch,
                'campaign-template-saved-search',
                $savedSearchId
            )]
        ));
    }

    /** @param array<string, mixed> $params @return array<string, mixed> */
    public function savedSearchResults(string $savedSearchId, array $params = []): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-saved-searches/'
                . rawurlencode($savedSearchId)
                . '/results',
            null,
            $params
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function create(array $input): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-templates',
            $input
        ));
    }

    /** @param array<string, mixed> $patch @return array<string, mixed> */
    public function update(string $templateId, array $patch, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'PATCH',
            '/api/v1/campaign-templates/' . rawurlencode($templateId),
            $patch,
            [],
            ['If-Match' => self::strongETag($ifMatch)]
        ));
    }

    /** @return array<string, mixed> */
    public function archive(string $templateId, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'PATCH',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/archive',
            null,
            [],
            ['If-Match' => self::strongETag($ifMatch)]
        ));
    }

    /** @return array<string, mixed> */
    public function restore(string $templateId, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'PATCH',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/restore',
            null,
            [],
            ['If-Match' => self::strongETag($ifMatch)]
        ));
    }

    /**
     * Compatibility alias for recoverable archival; no hard delete occurs.
     *
     * @return array<string, mixed>
     */
    public function delete(string $templateId, string $ifMatch): array
    {
        return self::arrayResult($this->client->request(
            'DELETE',
            '/api/v1/campaign-templates/' . rawurlencode($templateId),
            null,
            [],
            ['If-Match' => self::strongETag($ifMatch)]
        ));
    }

    /** @param array{page?: int, per_page?: int} $params @return array<string, mixed> */
    public function listRevisions(string $templateId, array $params = []): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/revisions',
            null,
            $params
        ));
    }

    /** @return array<string, mixed> */
    public function getRevision(string $templateId, int $version): array
    {
        if ($version < 1) {
            throw new \InvalidArgumentException('version must be a positive integer');
        }
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-templates/'
                . rawurlencode($templateId)
                . '/revisions/'
                . $version
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function clone(string $templateId, array $input = []): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-templates/' . rawurlencode($templateId) . '/clone',
            $input
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function adapt(
        string $templateId,
        array $input,
        string $idempotencyKey
    ): array {
        $input['mode'] = 'adapt';
        $input['source_template_id'] = $templateId;
        return $this->createDesign($input, $idempotencyKey);
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function generate(array $input, string $idempotencyKey): array
    {
        $input['mode'] = 'generate';
        return $this->createDesign($input, $idempotencyKey);
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createDesign(array $input, string $idempotencyKey): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /**
     * Recover active durable design jobs created by this exact authenticated
     * actor. The server returns compact newest-first summaries and binds every
     * continuation cursor to the same tenant and actor.
     *
     * @return array<string, mixed>
     */
    public function listDesigns(
        ?int $limit = null,
        ?string $cursor = null
    ): array {
        if ($limit !== null && ($limit < 1 || $limit > 50)) {
            throw new \InvalidArgumentException(
                'design list limit must be an integer between 1 and 50'
            );
        }
        $trimmedCursor = $cursor === null
            ? null
            : preg_replace('/^\s+|\s+$/u', '', $cursor);
        if (
            $cursor !== null
            && (
                $trimmedCursor === null
                || $cursor !== $trimmedCursor
                || strlen($cursor) > 1024
            )
        ) {
            throw new \InvalidArgumentException(
                'design list cursor must be unchanged and at most 1024 UTF-8 bytes'
            );
        }
        $query = [];
        if ($limit !== null) {
            $query['limit'] = $limit;
        }
        if ($cursor !== null) {
            $query['cursor'] = $cursor;
        }
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-designs',
            null,
            $query
        ));
    }

    /** @return array<string, mixed> */
    public function getDesign(string $designId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-designs/' . rawurlencode($designId)
        ));
    }

    /** @return array<string, mixed> */
    public function listDesignRevisions(string $designId): array
    {
        return self::arrayResult($this->client->request(
            'GET',
            '/api/v1/campaign-template-designs/'
                . rawurlencode($designId)
                . '/revisions'
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function refineDesign(
        string $designId,
        array $input,
        string $idempotencyKey
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs/' . rawurlencode($designId) . '/refine',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @return array<string, mixed> */
    public function retryDesign(string $designId, string $idempotencyKey): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs/' . rawurlencode($designId) . '/retry',
            null,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function saveDesign(
        string $designId,
        array $input,
        string $idempotencyKey
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs/' . rawurlencode($designId) . '/save',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createCampaignFromDesign(
        string $designId,
        array $input,
        string $idempotencyKey
    ): array {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs/'
                . rawurlencode($designId)
                . '/create-campaign',
            $input,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @return array<string, mixed> */
    public function archiveDesign(string $designId, string $idempotencyKey): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaign-template-designs/' . rawurlencode($designId) . '/archive',
            null,
            [],
            ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)]
        ));
    }

    /** @param array<string, mixed> $input @return array<string, mixed> */
    public function createCampaign(array $input): array
    {
        return self::arrayResult($this->client->request(
            'POST',
            '/api/v1/campaigns/from-template',
            $input
        ));
    }

    /** @param array<string, mixed> $params @return array<string, mixed> */
    private static function searchQuery(array $params): array
    {
        if (isset($params['tags']) && is_array($params['tags'])) {
            $params['tags'] = implode(',', $params['tags']);
        }
        return $params;
    }

    private static function strongETag(string $value): string
    {
        if (preg_match('/^"[^"\r\n]+"$/D', $value) !== 1) {
            throw new \InvalidArgumentException(
                'ifMatch must be the exact strong etag returned by the API'
            );
        }
        return $value;
    }

    private static function discoveryIfMatch(
        string $value,
        string $resource,
        string $id
    ): string {
        $pattern = '/^"(campaign-template-collection|campaign-template-saved-search):'
            . '([^"\\\\\s,]+):v([1-9]\d*)"$/D';
        if (
            preg_match($pattern, $value, $matches) !== 1
            || $matches[1] !== $resource
            || $matches[2] !== $id
        ) {
            throw new \InvalidArgumentException(
                "ifMatch must be the exact current $resource etag returned by the API"
            );
        }
        return $value;
    }

    private static function idempotencyKey(string $value): string
    {
        if (
            $value === ''
            || strlen($value) > 255
            || preg_match('/[\x00-\x1F\x7F-\x9F]/', $value) === 1
        ) {
            throw new \InvalidArgumentException(
                'idempotencyKey must be 1-255 bytes without control characters'
            );
        }
        return $value;
    }

    /** @return array<string, mixed> */
    private static function arrayResult(mixed $value): array
    {
        return is_array($value) ? $value : [];
    }
}
