<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * EmailsResource — transactional email: fire a single message (or a batch)
 * from your app. Mirrors packages/sdk-ts/src/resources/emails.ts.
 *
 * `to`/`cc`/`bcc`/`reply_to` accept a string or an array; one of `html`/`text`
 * is required; `from` defaults to the tenant's configured sender when omitted.
 * Attachments: [{filename, content(base64)|path, content_type?, content_id?}].
 */
final class EmailsResource extends Resource
{
    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function send(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/emails', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<int, array<string, mixed>> $emails
     * @return array<string, mixed>
     */
    public function sendBatch(array $emails): array
    {
        $out = $this->client->request('POST', '/api/v1/emails/batch', ['emails' => $emails]);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/emails/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function list(?int $limit = null): array
    {
        $query = $limit !== null ? ['limit' => $limit] : [];
        $out = $this->client->request('GET', '/api/v1/emails', null, $query);
        return is_array($out) ? $out : [];
    }
}
