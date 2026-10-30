<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * SequencesResource wraps the AI-backed multi-email sequence generator.
 * generate()/regenerate() may return either the full sequence (sync mode)
 * or a job acknowledgement ({job_id, status}); poll getJob() for terminal
 * state. Mirrors packages/sdk-ts/src/resources/sequences.ts.
 */
final class SequencesResource extends Resource
{
    /** @return array<int, mixed> */
    public function list(): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/sequences');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function get(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/sequences/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }

    /**
     * Kick off generation. Async returns {job_id, status}; sync returns
     * the full sequence body.
     *
     * @param array<string, mixed> $req
     * @return array<string, mixed>
     */
    public function generate(array $req): array
    {
        $out = $this->client->request('POST', '/api/v1/voice/sequences', $req);
        return is_array($out) ? $out : [];
    }

    /**
     * Regenerate a single email at a 1-based position.
     *
     * @param array<string, mixed> $req
     * @return array<string, mixed>
     */
    public function regenerate(string $id, int $position, array $req = []): array
    {
        if ($position < 1) {
            throw new \InvalidArgumentException('Sequence email position must be a positive integer');
        }
        $out = $this->client->request(
            'POST',
            '/api/v1/voice/sequences/' . rawurlencode($id) . '/regenerate/' . $position,
            $req
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Poll a sequence-generation job for terminal status.
     *
     * @return array<string, mixed>
     */
    public function getJob(string $jobId): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/sequences/jobs/' . rawurlencode($jobId));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $req
     * @return array<string, mixed>
     */
    public function update(string $id, array $req, int $expectedVersion): array
    {
        $out = $this->client->request(
            'PATCH',
            '/api/v1/voice/sequences/' . rawurlencode($id),
            $req,
            [],
            ['If-Match' => self::sequenceIfMatch($expectedVersion)]
        );
        return is_array($out) ? $out : [];
    }

    public function delete(string $id, int $expectedVersion): void
    {
        $this->client->request(
            'DELETE',
            '/api/v1/voice/sequences/' . rawurlencode($id),
            null,
            [],
            ['If-Match' => self::sequenceIfMatch($expectedVersion)]
        );
    }

    /** Convert a confirmed body revision into the canonical strong ETag. */
    private static function sequenceIfMatch(int $expectedVersion): string
    {
        if ($expectedVersion < 1) {
            throw new \InvalidArgumentException(
                'Sequence expectedVersion must be a positive integer'
            );
        }
        return '"' . $expectedVersion . '"';
    }
}
