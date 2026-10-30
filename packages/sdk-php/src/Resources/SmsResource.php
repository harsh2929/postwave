<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Errors\PostwaveError;
use Moosewave\Errors\ServerError;

final class SmsResource extends Resource
{
    public const EVIDENCE_READ_RELEASE_HELD_CODE = 'sms_evidence_read_release_held';
    public const A2P_REGISTRATION_RELEASE_HELD_CODE = 'sms_a2p_registration_release_held';
    public const REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE = 'sms_registration_evidence_authority_required';
    public const CAMPAIGN_DISPATCH_RELEASE_HELD_CODE = 'sms_campaign_dispatch_release_held';
    public const CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE = 'sms_campaign_schedule_release_held';
    public const CAMPAIGN_RESUME_RELEASE_HELD_CODE = 'sms_campaign_resume_release_held';
    public const TEST_DISPATCH_RELEASE_HELD_CODE = 'sms_test_dispatch_release_held';
    private const SUPPRESSION_REASONS = ['manual', 'stop_keyword', 'help_keyword', 'carrier_block', 'complaint', 'quiet_hours', 'expired'];
    private const SUPPRESSION_SOURCES = ['twilio', 'telnyx', 'bandwidth', 'manual', 'api', 'import'];
    private const SUPPRESSION_LOCKED_REASON = 'carrier_or_system_authority';

    /** @return array<string, mixed> */
    public function setup(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/setup');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function compliance(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/compliance');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function pilotReadiness(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/pilot-readiness');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function senderPilotCertification(string $senderId): array
    {
        $out = $this->client->request(
            'GET',
            '/api/v1/sms/senders/' . IntegrationsResource::pathSegment($senderId, 'sms sender id') . '/pilot-certification'
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function listLists(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/lists');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{name: string, description?: string, keyword?: string, sender_profile_id?: string} $input
     * @return array<string, mixed>
     */
    public function createList(array $input): array
    {
        $out = $this->client->request('POST', '/api/v1/sms/lists', $input);
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function listSenders(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/senders');
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function upsertSender(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/senders',
            self::validatedSenderInput($input)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    private static function validatedSenderInput(array $input): array
    {
        $hasPrivateEvidence = array_key_exists('brand_registration_sid', $input)
            || array_key_exists('campaign_registration_sid', $input);
        $hasStatus = array_key_exists('registration_status', $input);
        $status = $input['registration_status'] ?? null;
        if (
            $hasPrivateEvidence ||
            ($hasStatus && !in_array($status, ['', 'not_started', 'draft'], true))
        ) {
            throw new PostwaveError(
                'Caller-supplied SMS registration evidence and provider-certified status are unavailable.',
                409,
                self::REGISTRATION_EVIDENCE_AUTHORITY_REQUIRED_CODE
            );
        }
        return $input;
    }

    /** @return array<string, mixed> */
    public function pauseSender(string $senderId, ?string $reason = null): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/senders/' . IntegrationsResource::pathSegment($senderId, 'sms sender id') . '/pause',
            ['reason' => $reason]
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function resumeSender(string $senderId): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/senders/' . IntegrationsResource::pathSegment($senderId, 'sms sender id') . '/resume',
            []
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function submitBrandRegistration(string $senderId, array $input): array
    {
        unset($senderId, $input);
        throw self::operationReleaseHeld(
            self::A2P_REGISTRATION_RELEASE_HELD_CODE,
            'SMS A2P registration'
        );
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function submitCampaignRegistration(string $senderId, array $input): array
    {
        unset($senderId, $input);
        throw self::operationReleaseHeld(
            self::A2P_REGISTRATION_RELEASE_HELD_CODE,
            'SMS A2P registration'
        );
    }

    /** @return array<string, mixed> */
    public function pollA2PRegistration(string $senderId): array
    {
        unset($senderId);
        throw self::operationReleaseHeld(
            self::A2P_REGISTRATION_RELEASE_HELD_CODE,
            'SMS A2P registration'
        );
    }

    /**
     * @param array{phone_e164: string, action: 'revoked', source: 'manual', proof_text: string, list_id?: string} $input
     * @return array<string, mixed>
     */
    public function recordConsent(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/consent',
            self::validatedConsentRevocation($input)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * Return one exact-admin, response-cutoff-bound page. nextCursor is opaque
     * and continuation is always caller-controlled.
     *
     * @param array{reason?: string, phone?: string, cursor?: string, limit?: int} $options
     * @return array<string, mixed>
     */
    public function listSuppressions(string $expectedTenantId, array $options = []): array
    {
        self::canonicalTenant($expectedTenantId);
        $allowed = ['reason', 'phone', 'cursor', 'limit'];
        if (array_diff(array_keys($options), $allowed) !== []) {
            throw new \InvalidArgumentException('SMS suppression list options contain an unsupported field');
        }
        $limit = $options['limit'] ?? 100;
        if (!is_int($limit) || $limit < 1 || $limit > 200) {
            throw new \InvalidArgumentException('SMS suppression limit must be an integer from 1 to 200');
        }
        $reason = $options['reason'] ?? null;
        if ($reason !== null && (!is_string($reason) || !in_array($reason, self::SUPPRESSION_REASONS, true))) {
            throw new \InvalidArgumentException('SMS suppression reason is unsupported');
        }
        $phone = $options['phone'] ?? null;
        if ($phone !== null && (!is_string($phone) || preg_match('/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/D', $phone) !== 1)) {
            throw new \InvalidArgumentException('SMS suppression phone must be canonical US/Canada E.164');
        }
        $cursor = $options['cursor'] ?? null;
        if ($cursor !== null) {
            self::strictSuppressionText($cursor, 4096);
            if (preg_match('/^v1\.[A-Za-z0-9_-]+$/D', $cursor) !== 1) {
                throw new \InvalidArgumentException('SMS suppression cursor is invalid');
            }
        }
        if ($phone !== null && $cursor !== null) {
            throw new \InvalidArgumentException('Exact SMS suppression lookup cannot continue a cursor');
        }
        if ($phone !== null && array_key_exists('limit', $options)) {
            throw new \InvalidArgumentException('Exact SMS suppression lookup does not accept a limit');
        }
        $request = [
            'limit' => $limit,
            ...($reason !== null ? ['reason' => $reason] : []),
            ...($phone !== null ? ['phone' => $phone] : []),
            ...($cursor !== null ? ['cursor' => $cursor] : []),
        ];
        $raw = $phone !== null
            ? $this->client->request('POST', '/api/v1/sms/suppressions/query', [
                'phone' => $phone,
                ...($reason !== null ? ['reason' => $reason] : []),
            ])
            : $this->client->request('GET', '/api/v1/sms/suppressions', null, $request);
        return self::decodeSuppressionPage($raw, $expectedTenantId, $phone !== null ? 1 : $limit, $reason, $phone);
    }

    /** @return array<string, mixed> */
    public function addSuppression(string $phone, string $reason = 'manual'): array
    {
        if (preg_match('/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/D', $phone) !== 1 || $reason !== 'manual') {
            throw new \InvalidArgumentException('SMS suppression add requires canonical US/Canada E.164 and reason=manual');
        }
        $row = self::decodeSuppressionRow(
            $this->client->request('POST', '/api/v1/sms/suppressions', ['phone' => $phone, 'reason' => 'manual'])
        );
        if ($row['phone_e164'] !== $phone || $row['reversible'] !== true) {
            throw self::suppressionContractError();
        }
        return $row;
    }

    /** @return array{ok: true, tenantId: string, id: string} */
    public function removeSuppression(string $id, string $expectedTenantId): array
    {
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $id) !== 1) {
            throw new \InvalidArgumentException('SMS suppression id must be a canonical lowercase UUIDv4');
        }
        self::canonicalTenant($expectedTenantId);
        $raw = $this->client->request('DELETE', '/api/v1/sms/suppressions/' . $id);
        if (
            !is_array($raw) || count($raw) !== 3 ||
            array_diff(array_keys($raw), ['ok', 'tenantId', 'id']) !== [] ||
            $raw['ok'] !== true || ($raw['tenantId'] ?? null) !== $expectedTenantId ||
            ($raw['id'] ?? null) !== $id
        ) {
            throw self::suppressionContractError();
        }
        return ['ok' => true, 'tenantId' => $expectedTenantId, 'id' => $id];
    }

    private static function suppressionContractError(): PostwaveError
    {
        return new PostwaveError('Invalid SMS suppression response.', 502, 'invalid_sms_suppression_response');
    }

    private static function strictSuppressionText(mixed $value, int $maximum): string
    {
        if (
            !is_string($value) || $value === '' || strlen($value) > $maximum || trim($value) !== $value ||
            preg_match('/[\p{Cc}\p{Cf}\p{Cs}]/u', $value) === 1
        ) {
            throw self::suppressionContractError();
        }
        return $value;
    }

    private static function canonicalTenant(mixed $value): string
    {
        $tenant = self::strictSuppressionText($value, 36);
        if (preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D', $tenant) !== 1) {
            throw new \InvalidArgumentException('SMS suppression tenant id must be a canonical lowercase UUID');
        }
        return $tenant;
    }

    private static function suppressionTimestamp(mixed $value): string
    {
        $text = self::strictSuppressionText($value, 64);
        if (preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/D', $text, $parts) !== 1) {
            throw self::suppressionContractError();
        }
        if (
            (int) $parts[1] < 2000 || (int) $parts[1] >= 2100 ||
            !checkdate((int) $parts[2], (int) $parts[3], (int) $parts[1]) ||
            (int) $parts[4] > 23 || (int) $parts[5] > 59 || (int) $parts[6] > 59 ||
            (isset($parts[7]) && ((int) $parts[7] > 14 || ((int) $parts[7] === 14 && (int) $parts[8] !== 0) || (int) $parts[8] > 59))
        ) {
            throw self::suppressionContractError();
        }
        $normalized = preg_replace('/(\.\d{6})\d+/', '$1', $text);
        $instant = is_string($normalized) ? strtotime($normalized) : false;
        $minimum = strtotime('2000-01-01T00:00:00Z');
        $maximum = strtotime('2100-01-01T00:00:00Z');
        if (
            $instant === false || $minimum === false || $maximum === false ||
            $instant < $minimum || $instant >= $maximum
        ) {
            throw self::suppressionContractError();
        }
        return $text;
    }

    /** @return array<string, mixed> */
    private static function decodeSuppressionRow(mixed $value): array
    {
        $allowed = ['id', 'phone_e164', 'reason', 'source', 'created_at', 'reversible', 'locked_reason'];
        if (!is_array($value) || array_diff(array_keys($value), $allowed) !== []) {
            throw self::suppressionContractError();
        }
        $id = self::strictSuppressionText($value['id'] ?? null, 36);
        $phone = self::strictSuppressionText($value['phone_e164'] ?? null, 16);
        $reason = self::strictSuppressionText($value['reason'] ?? null, 128);
        $source = self::strictSuppressionText($value['source'] ?? null, 128);
        $createdAt = self::suppressionTimestamp($value['created_at'] ?? null);
        $reversible = $value['reversible'] ?? null;
        $locked = array_key_exists('locked_reason', $value)
            ? self::strictSuppressionText($value['locked_reason'], 256)
            : null;
        if (
            preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $id) !== 1 ||
            preg_match('/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/D', $phone) !== 1 ||
            !in_array($reason, self::SUPPRESSION_REASONS, true) ||
            !in_array($source, self::SUPPRESSION_SOURCES, true) ||
            !is_bool($reversible) ||
            $reversible !== ($reason === 'manual' && $source === 'manual') ||
            ($reversible && array_key_exists('locked_reason', $value)) ||
            (!$reversible && $locked !== self::SUPPRESSION_LOCKED_REASON)
        ) {
            throw self::suppressionContractError();
        }
        return [
            'id' => $id,
            'phone_e164' => $phone,
            'reason' => $reason,
            'source' => $source,
            'created_at' => $createdAt,
            'reversible' => $reversible,
            ...($locked !== null ? ['locked_reason' => $locked] : []),
        ];
    }

    /** @return array<string, mixed> */
    private static function decodeSuppressionPage(
        mixed $value,
        string $expectedTenant,
        int $limit,
        ?string $expectedReason = null,
        ?string $expectedPhone = null
    ): array
    {
        $allowed = ['tenantId', 'items', 'total', 'nextCursor', 'snapshotAt'];
        if (!is_array($value) || array_diff(array_keys($value), $allowed) !== [] || !isset($value['items']) || !is_array($value['items']) || count($value['items']) > $limit) {
            throw self::suppressionContractError();
        }
        $tenant = self::canonicalTenant($value['tenantId'] ?? null);
        if ($tenant !== $expectedTenant) {
            throw self::suppressionContractError();
        }
        $total = $value['total'] ?? null;
        if (!is_int($total) || $total < count($value['items'])) {
            throw self::suppressionContractError();
        }
        $snapshot = self::suppressionTimestamp($value['snapshotAt'] ?? null);
        $cursor = array_key_exists('nextCursor', $value)
            ? self::strictSuppressionText($value['nextCursor'], 4096)
            : null;
        if ($cursor !== null && preg_match('/^v1\.[A-Za-z0-9_-]+$/D', $cursor) !== 1) {
            throw self::suppressionContractError();
        }
        $items = array_map(self::decodeSuppressionRow(...), $value['items']);
        $ids = [];
        $phones = [];
        $priorTime = INF;
        $priorId = '';
        $snapshotTime = strtotime($snapshot);
        foreach ($items as $row) {
            $createdTime = strtotime($row['created_at']);
            if (
                isset($ids[$row['id']]) || isset($phones[$row['phone_e164']]) ||
                ($expectedReason !== null && $row['reason'] !== $expectedReason) ||
                ($expectedPhone !== null && $row['phone_e164'] !== $expectedPhone) ||
                $createdTime === false || $snapshotTime === false || $createdTime > $snapshotTime ||
                $createdTime > $priorTime || ($createdTime === $priorTime && $priorId !== '' && strcmp($row['id'], $priorId) >= 0)
            ) {
                throw self::suppressionContractError();
            }
            $ids[$row['id']] = true;
            $phones[$row['phone_e164']] = true;
            $priorTime = $createdTime;
            $priorId = $row['id'];
        }
        if ($cursor !== null && ($total <= count($items) || count($items) !== $limit)) {
            throw self::suppressionContractError();
        }
        if ($expectedPhone !== null && ($total > 1 || $cursor !== null)) {
            throw self::suppressionContractError();
        }
        return [
            'tenantId' => $tenant,
            'items' => $items,
            'total' => $total,
            'snapshotAt' => $snapshot,
            ...($cursor !== null ? ['nextCursor' => $cursor] : []),
        ];
    }

    /**
     * @param array<string, mixed> $input
     * @return array{phone_e164: string, action: 'revoked', source: 'manual', proof_text: string, list_id?: string}
     */
    private static function validatedConsentRevocation(array $input): array
    {
        $action = $input['action'] ?? null;
        if ($action === 'granted') {
            throw new PostwaveError(
                'Only a verified provider START or UNSTOP event may restore SMS consent.',
                409,
                'carrier_resubscribe_authority_required'
            );
        }
        if ($action !== 'revoked') {
            throw new PostwaveError(
                'The operator SMS consent endpoint accepts only action=revoked.',
                400,
                'invalid_consent_action'
            );
        }
        $allowed = ['action', 'list_id', 'phone_e164', 'proof_text', 'source'];
        if (($input['source'] ?? null) !== 'manual' || array_diff(array_keys($input), $allowed) !== []) {
            throw new PostwaveError(
                'Operator SMS revocations require source=manual and no provider or subscriber evidence fields.',
                400,
                'invalid_consent_request'
            );
        }
        $phone = $input['phone_e164'] ?? null;
        if (!is_string($phone) || preg_match('/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/D', $phone) !== 1) {
            throw new PostwaveError(
                'phone_e164 must be a canonical US/Canada number.',
                400,
                'invalid_phone'
            );
        }
        $reason = $input['proof_text'] ?? null;
        $trimmed = is_string($reason) ? preg_replace('/^\s+|\s+$/u', '', $reason) : null;
        $pointCount = is_string($trimmed) ? preg_match_all('/./us', $trimmed) : false;
        if (
            !is_string($trimmed) ||
            $trimmed === '' ||
            $pointCount === false ||
            $pointCount > 500 ||
            preg_match('/[\p{Cc}\p{Cf}\p{Cs}]/u', $trimmed) === 1
        ) {
            throw new PostwaveError(
                'proof_text must contain a safe operator revocation reason of at most 500 Unicode code points.',
                400,
                'consent_reason_required'
            );
        }
        $listId = $input['list_id'] ?? null;
        if (
            $listId !== null &&
            (!is_string($listId) || preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D', $listId) !== 1)
        ) {
            throw new PostwaveError(
                'list_id must be a canonical lowercase UUIDv4.',
                400,
                'invalid_list_id'
            );
        }
        return [
            ...($listId !== null ? ['list_id' => $listId] : []),
            'phone_e164' => $phone,
            'action' => 'revoked',
            'source' => 'manual',
            'proof_text' => $trimmed,
        ];
    }

    /** @return array<string, mixed> */
    public function listCampaigns(): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/campaigns');
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function getCampaign(string $id): array
    {
        $out = $this->client->request('GET', '/api/v1/sms/campaigns/' . IntegrationsResource::pathSegment($id, 'sms campaign id'));
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public function createCampaign(array $input): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/campaigns',
            self::validatedCampaignDraftInput($input)
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    private static function validatedCampaignDraftInput(array $input): array
    {
        if (
            ($input['status'] ?? null) === 'scheduled' ||
            array_key_exists('scheduled_at', $input)
        ) {
            throw self::operationReleaseHeld(
                self::CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
                'SMS campaign scheduling'
            );
        }
        return $input;
    }

    /** @return array<string, mixed> */
    public function campaignReport(string $id): array
    {
        unset($id);
        throw self::evidenceReadReleaseHeld();
    }

    /**
     * @param array{status?: string, limit?: int} $query
     */
    public function exportCampaignReport(string $id, array $query = []): string
    {
        unset($id, $query);
        throw self::evidenceReadReleaseHeld();
    }

    private static function evidenceReadReleaseHeld(): ServerError
    {
        return new ServerError(
            'Confidential SMS evidence reads are release-held until the audited bounded contract is available.',
            self::EVIDENCE_READ_RELEASE_HELD_CODE,
            503
        );
    }

    private static function operationReleaseHeld(string $code, string $operation): ServerError
    {
        return new ServerError(
            $operation . ' is release-held until its durable provider and reconciliation contract is available.',
            $code,
            503
        );
    }

    /** @return array<string, mixed> */
    public function sendCampaign(string $id, array $input = []): array
    {
        unset($id, $input);
        throw self::operationReleaseHeld(
            self::CAMPAIGN_DISPATCH_RELEASE_HELD_CODE,
            'SMS campaign dispatch'
        );
    }

    /** @return array<string, mixed> */
    public function scheduleCampaign(string $id, string $scheduledAt): array
    {
        unset($id, $scheduledAt);
        throw self::operationReleaseHeld(
            self::CAMPAIGN_SCHEDULE_RELEASE_HELD_CODE,
            'SMS campaign scheduling'
        );
    }

    /** @return array<string, mixed> */
    public function pauseCampaign(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/campaigns/' . IntegrationsResource::pathSegment($id, 'sms campaign id') . '/pause',
            []
        );
        return is_array($out) ? $out : [];
    }

    /** @return array<string, mixed> */
    public function resumeCampaign(string $id): array
    {
        unset($id);
        throw self::operationReleaseHeld(
            self::CAMPAIGN_RESUME_RELEASE_HELD_CODE,
            'SMS campaign resume'
        );
    }

    /** @return array<string, mixed> */
    public function cancelCampaign(string $id): array
    {
        $out = $this->client->request(
            'POST',
            '/api/v1/sms/campaigns/' . IntegrationsResource::pathSegment($id, 'sms campaign id') . '/cancel',
            []
        );
        return is_array($out) ? $out : [];
    }

    /**
     * @param array{sender_profile_id: string, list_id: string, to: string, body: string, media_url?: string, campaign_id?: string, metadata?: array<string, mixed>} $input
     * @return array<string, mixed>
     */
    public function sendTest(array $input): array
    {
        unset($input);
        throw self::operationReleaseHeld(
            self::TEST_DISPATCH_RELEASE_HELD_CODE,
            'SMS test dispatch'
        );
    }
}
