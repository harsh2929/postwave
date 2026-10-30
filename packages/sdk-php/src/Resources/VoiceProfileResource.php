<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * VoiceProfileResource — brand voice profile + source ingestion.
 * Mirrors packages/sdk-ts/src/resources/voice-profile.ts.
 */
final class VoiceProfileResource extends Resource
{
    /** @return array<string, mixed> */
    public function get(): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/profile');
        return is_array($out) ? $out : [];
    }

    /** Re-build the profile from currently-ingested sources. */
    /** @return array<string, mixed> */
    public function build(): array
    {
        $out = $this->client->request('POST', '/api/v1/voice/profile/build');
        return is_array($out) ? $out : [];
    }

    /** @return array<int, mixed> */
    public function listSources(): array
    {
        $out = $this->client->request('GET', '/api/v1/voice/sources');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function addSource(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/voice/sources', $input);
        return is_array($out) ? $out : [];
    }

    /**
     * Kick off ingestion. Returns `{job_id}`; poll getIngestJob() until
     * terminal status.
     *
     * @return array<string, mixed>
     */
    public function ingestSource(string $sourceID): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/voice/sources/' . rawurlencode($sourceID) . '/ingest'
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Poll an ingest job started by ingestSource().
     *
     * @return array<string, mixed>
     */
    public function getIngestJob(string $sourceID, string $jobID): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/voice/sources/' . rawurlencode($sourceID)
                . '/ingest/' . rawurlencode($jobID)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Convenience: poll until terminal. Constant 2s backoff, 5 min
     * timeout by default. Same shape as VoiceProfileResource.waitForIngestJob
     * in the TS SDK.
     *
     * @return array<string, mixed>
     */
    public function waitForIngestJob(
        string $sourceID,
        string $jobID,
        int $intervalMs = 2000,
        int $timeoutMs = 300000
    ): array {
        $intervalMs = $intervalMs > 0 ? min($intervalMs, 30000) : 2000;
        $timeoutMs = $timeoutMs > 0 ? min($timeoutMs, 1800000) : 300000;
        $deadline = microtime(true) + ($timeoutMs / 1000);
        while (microtime(true) < $deadline) {
            $job = $this->getIngestJob($sourceID, $jobID);
            $status = $job['status'] ?? null;
            if ($status === 'succeeded' || $status === 'failed') {
                return $job;
            }
            $remainingMs = (int) (($deadline - microtime(true)) * 1000);
            usleep(min($intervalMs, max(0, $remainingMs)) * 1000);
        }
        throw new \RuntimeException("voice.waitForIngestJob($jobID): timed out after {$timeoutMs}ms");
    }

    /** @return array<string, mixed> */
    public function removeSource(string $id): array
    {
        $out = $this->client->request('DELETE', '/api/v1/voice/sources/' . rawurlencode($id));
        return is_array($out) ? $out : [];
    }
}
