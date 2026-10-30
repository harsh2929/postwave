<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\ParseError;

/**
 * SendingSettingsResource — per-tenant sending throttle + quiet hours.
 * Mirrors packages/sdk-ts/src/resources/sending-settings.ts.
 */
final class SendingSettingsResource extends Resource
{
    public const RECONCILIATION_WAIT_SECONDS = 35;

    private const INVALID_COMMITTED_RESPONSE =
        'Sending-settings write returned an invalid committed response; ' .
        'wait at least 35 seconds from submission, then reconcile canonical ' .
        'settings and cap status before retrying.';

    private const SENDING_SETTINGS_KEYS = [
        'tenant_id',
        'max_sends_per_hour',
        'quiet_hours_start',
        'quiet_hours_end',
        'quiet_hours_tz',
        'quiet_hours_per_recipient',
        'fallback_hour_utc',
        'updated_by_user_id',
        'updated_at',
        'ip_pool',
    ];

    private const SENDING_SETTINGS_IP_POOL_KEYS = ['name', 'dedicated'];

    /** @return array<string, mixed> */
    public function get(): array
    {
        $out = $this->client->request('GET', '/api/v1/settings/sending');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function status(): array
    {
        $out = $this->client->request('GET', '/api/v1/settings/sending/status');
        return is_array($out) ? $out : [];
    }

    /**
     * Replace settings with exactly one wire attempt. A transport error or
     * non-200 response may follow a durable commit. Wait at least 35 seconds
     * from submission, then reconcile get() and status() before retrying.
     *
     * @param array{
     *   max_sends_per_hour?: int|null,
     *   quiet_hours_start?: string,
     *   quiet_hours_end?: string,
     *   quiet_hours_tz?: string,
     *   quiet_hours_per_recipient?: bool,
     *   fallback_hour_utc?: int|null,
     *   expected_updated_at?: string
     * } $input
     * @return array<string, mixed>
     */
    public function set(array $input): array
    {
        $response = $this->client->requestSendingSettingsWrite($input);
        $out = $response['data'];
        if (
            ($response['headers']['x-postwave-sending-cap-outcome'] ?? '') !== 'committed'
            || !self::isSendingSettings($out)
            || !self::matchesSubmittedSettings($out, $input)
        ) {
            throw new ParseError(
                self::INVALID_COMMITTED_RESPONSE,
                200,
                $response['headers']['x-request-id'] ?? null
            );
        }
        return $out;
    }

    private static function isSendingSettings(mixed $value): bool
    {
        if (
            !is_array($value)
            || array_is_list($value)
            || array_diff(array_keys($value), self::SENDING_SETTINGS_KEYS) !== []
        ) {
            return false;
        }
        if (
            !isset($value['tenant_id'])
            || !is_string($value['tenant_id'])
            || !self::isCanonicalUuid($value['tenant_id'])
            || !array_key_exists('quiet_hours_per_recipient', $value)
            || !is_bool($value['quiet_hours_per_recipient'])
            || !self::isCommittedRevision($value['updated_at'] ?? null)
        ) {
            return false;
        }
        if (
            array_key_exists('max_sends_per_hour', $value)
            && $value['max_sends_per_hour'] !== null
            && (
                !is_int($value['max_sends_per_hour'])
                || $value['max_sends_per_hour'] < 1
                || $value['max_sends_per_hour'] > 1_000_000
            )
        ) {
            return false;
        }
        if (!self::isCanonicalQuietPolicy($value)) {
            return false;
        }
        if (
            array_key_exists('fallback_hour_utc', $value)
            && $value['fallback_hour_utc'] !== null
            && (
                !is_int($value['fallback_hour_utc'])
                || $value['fallback_hour_utc'] < 0
                || $value['fallback_hour_utc'] > 23
            )
        ) {
            return false;
        }
        if (
            array_key_exists('updated_by_user_id', $value)
            && $value['updated_by_user_id'] !== null
            && (!is_string($value['updated_by_user_id'])
                || !self::isCanonicalUuid($value['updated_by_user_id']))
        ) {
            return false;
        }
        return self::isCanonicalIpPool($value['ip_pool'] ?? null);
    }

    private static function isCanonicalUuid(string $value): bool
    {
        return preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/Di',
            $value
        ) === 1;
    }

    /** @param array<string, mixed> $row */
    private static function isCanonicalQuietPolicy(array $row): bool
    {
        $start = $row['quiet_hours_start'] ?? '';
        $end = $row['quiet_hours_end'] ?? '';
        $timezone = $row['quiet_hours_tz'] ?? '';
        if (!is_string($start) || !is_string($end) || !is_string($timezone)) {
            return false;
        }
        if ($start === '' && $end === '' && $timezone === '') {
            return true;
        }
        if (
            preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/D', $start) !== 1
            || preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/D', $end) !== 1
            || $start === $end
            || $timezone === ''
            || strlen($timezone) > 128
        ) {
            return false;
        }
        return $timezone === 'UTC'
            || in_array(
                $timezone,
                timezone_identifiers_list(\DateTimeZone::ALL_WITH_BC),
                true
            );
    }

    private static function isCanonicalIpPool(mixed $value): bool
    {
        if ($value === null) {
            return true;
        }
        return is_array($value)
            && !array_is_list($value)
            && array_diff(array_keys($value), self::SENDING_SETTINGS_IP_POOL_KEYS) === []
            && isset($value['name'])
            && is_string($value['name'])
            && trim($value['name']) !== ''
            && strlen($value['name']) <= 160
            && array_key_exists('dedicated', $value)
            && is_bool($value['dedicated']);
    }

    /**
     * @param array<string, mixed> $row
     * @param array<string, mixed> $input
     */
    private static function matchesSubmittedSettings(array $row, array $input): bool
    {
        if (($row['max_sends_per_hour'] ?? null) !== ($input['max_sends_per_hour'] ?? null)) {
            return false;
        }
        foreach (['quiet_hours_start', 'quiet_hours_end', 'quiet_hours_tz'] as $field) {
            if (($row[$field] ?? '') !== ($input[$field] ?? '')) {
                return false;
            }
        }
        if (($row['quiet_hours_per_recipient'] ?? null) !== ($input['quiet_hours_per_recipient'] ?? true)) {
            return false;
        }
        if (
            array_key_exists('fallback_hour_utc', $input)
            && ($row['fallback_hour_utc'] ?? null) !== $input['fallback_hour_utc']
        ) {
            return false;
        }
        if (
            array_key_exists('expected_updated_at', $input)
            && !self::advancesSubmittedRevision(
                $row['updated_at'] ?? null,
                $input['expected_updated_at']
            )
        ) {
            return false;
        }
        return true;
    }

    private static function advancesSubmittedRevision(mixed $candidate, mixed $expected): bool
    {
        if ($expected === '') {
            return true;
        }
        if (!is_string($candidate) || !is_string($expected)) {
            return false;
        }
        $candidateParts = self::revisionEpochParts($candidate);
        $expectedParts = self::revisionEpochParts($expected);
        if ($candidateParts === null || $expectedParts === null) {
            return false;
        }
        return $candidateParts[0] > $expectedParts[0]
            || ($candidateParts[0] === $expectedParts[0]
                && $candidateParts[1] > $expectedParts[1]);
    }

    private static function isCommittedRevision(mixed $value): bool
    {
        return is_string($value)
            && $value !== '0001-01-01T00:00:00Z'
            && self::revisionEpochParts($value) !== null;
    }

    /** @return array{int, int}|null Epoch seconds plus nanosecond fraction. */
    private static function revisionEpochParts(string $value): ?array
    {
        $matches = [];
        if (
            preg_match(
                '/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})' .
                '(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/D',
                $value,
                $matches,
                PREG_UNMATCHED_AS_NULL
            ) !== 1
        ) {
            return null;
        }
        $year = (int) $matches[1];
        $month = (int) $matches[2];
        $day = (int) $matches[3];
        $hour = (int) $matches[4];
        $minute = (int) $matches[5];
        $second = (int) $matches[6];
        $fraction = is_string($matches[7] ?? null) ? $matches[7] : '';
        $offsetSign = is_string($matches[8] ?? null) ? $matches[8] : '+';
        $offsetHours = isset($matches[9]) ? (int) $matches[9] : 0;
        $offsetMinutes = isset($matches[10]) ? (int) $matches[10] : 0;
        if (
            $year < 2000
            || !checkdate($month, $day, $year)
            || $hour > 23
            || $minute > 59
            || $second > 59
            || $offsetHours > 14
            || $offsetMinutes > 59
            || ($offsetHours === 14 && $offsetMinutes !== 0)
        ) {
            return null;
        }
        try {
            $calendar = new \DateTimeImmutable(sprintf(
                '%04d-%02d-%02dT%02d:%02d:%02d%s%02d:%02d',
                $year,
                $month,
                $day,
                $hour,
                $minute,
                $second,
                $offsetSign,
                $offsetHours,
                $offsetMinutes
            ));
        } catch (\Exception) {
            return null;
        }
        $nanoseconds = (int) str_pad($fraction, 9, '0');
        return [$calendar->getTimestamp(), $nanoseconds];
    }
}
