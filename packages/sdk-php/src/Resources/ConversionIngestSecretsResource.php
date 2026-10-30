<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\AmbiguousConversionIngestSecretIssueError;
use Moosewave\Errors\ParseError;
use Moosewave\Errors\PostwaveError;

final class ConversionIngestSecretsResource extends Resource
{
    private const PATH = '/api/v1/conversions/ingest-secrets';

    /**
     * Return one bounded metadata-only page. This method never auto-walks.
     *
     * @return array{items: list<array<string, mixed>>, next_cursor?: string}
     */
    public function list(int $limit = 100, ?string $cursor = null): array
    {
        if ($limit < 1 || $limit > 100) {
            throw new \InvalidArgumentException('Signing-key limit must be from 1 to 100.');
        }
        if ($cursor !== null) {
            $cursor = ConversionIngestSecretsContract::cursor($cursor);
        }
        $raw = $this->client->request('GET', self::PATH, null, [
            'limit' => $limit,
            'cursor' => $cursor,
        ]);
        return ConversionIngestSecretsContract::decodePage($raw, $cursor);
    }

    /**
     * Mint with no Idempotency-Key and exactly one transport attempt. On an
     * ambiguous result, reconcile the register, revoke the possible new key,
     * then replace it; never retry issuance blindly.
     *
     * @return array{secret: array<string, mixed>, notice: string}
     */
    public function issue(string $label = ''): array
    {
        $label = ConversionIngestSecretsContract::label($label);
        try {
            $raw = $this->client->requestRevealOnce(
                self::PATH,
                $label === '' ? new \stdClass() : ['label' => $label]
            );
        } catch (PostwaveError $error) {
            if (
                !($error instanceof ParseError)
                && $error->status >= 400
                && $error->status < 500
            ) {
                throw $error;
            }
            throw new AmbiguousConversionIngestSecretIssueError();
        }
        try {
            $issued = ConversionIngestSecretsContract::decodeIssue($raw);
            if ($issued['secret']['label'] !== $label) {
                throw new \UnexpectedValueException('Issued key label did not match the request.');
            }
            return $issued;
        } catch (\UnexpectedValueException) {
            throw new AmbiguousConversionIngestSecretIssueError();
        }
    }

    /** @return array{revoked: true} */
    public function revoke(string $keyId): array
    {
        $keyId = ConversionIngestSecretsContract::keyId($keyId);
        $raw = $this->client->request(
            'POST',
            self::PATH . '/' . $keyId . '/revoke'
        );
        return ConversionIngestSecretsContract::decodeRevoked($raw);
    }
}
