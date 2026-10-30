<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

/**
 * Closed request-side contracts shared by Campaign Assurance operations.
 *
 * The API remains the authority for tenant ownership and mutable state. These
 * checks prevent malformed, ambiguous, or caller-extended public payloads from
 * reaching the transport.
 */
final class CampaignAssuranceContract
{
    /** @var list<string> */
    public const PROFILES = ['fast', 'full', 'calibration'];
    /** @var list<string> */
    public const APPEAL_DECISIONS = ['allow_send', 'reject'];

    /** @var list<string> */
    private const INTENT_KINDS = [
        'inform',
        'invite',
        'promote',
        'request_action',
        'remind',
        'survey',
        'transact',
        'onboard',
        'retain',
        'other',
    ];
    /** @var list<string> */
    private const PRIMARY_ACTION_ROLES = [
        'navigate',
        'register',
        'purchase',
        'rsvp',
        'confirm',
        'download',
        'survey',
        'reply',
        'track',
    ];
    /** @var list<string> */
    private const SECONDARY_ACTION_ROLES = [
        'unsubscribe',
        'preferences',
        'view_in_browser',
        'social',
        'legal',
        'share',
        'contact',
        'reply',
    ];
    /** @var list<string> */
    private const FACT_TYPES = [
        'text',
        'datetime',
        'money',
        'location',
        'code',
        'percentage',
        'quantity',
        'url',
    ];
    /** @var list<string> */
    private const CRITICALITIES = ['critical', 'important', 'supporting'];

    /**
     * Validate the direct Fact Contract v1 object, or the explicit empty
     * object represented to PHP callers as an empty array.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function factContract(array $input): array
    {
        if ($input === []) {
            return [];
        }

        self::closedObject(
            $input,
            [
                'schema_version',
                'primary_intent',
                'audience_context',
                'core_claim',
                'primary_action',
                'required_facts',
                'forbidden_claims',
                'allowed_secondary_actions',
                'language',
            ],
            [
                'schema_version',
                'primary_intent',
                'audience_context',
                'core_claim',
                'primary_action',
                'required_facts',
                'forbidden_claims',
                'allowed_secondary_actions',
                'language',
            ],
            'Fact Contract'
        );
        if ($input['schema_version'] !== 1) {
            throw new \InvalidArgumentException('Fact Contract schema_version must be exactly 1');
        }

        $intent = self::object($input['primary_intent'], 'Fact Contract primary_intent');
        self::closedObject($intent, ['kind', 'statement'], ['kind', 'statement'], 'Fact Contract primary_intent');
        self::enum($intent['kind'], self::INTENT_KINDS, 'Fact Contract primary_intent.kind');
        self::boundedString($intent['statement'], 1, 1000, 'Fact Contract primary_intent.statement');

        $audience = self::object($input['audience_context'], 'Fact Contract audience_context');
        self::closedObject(
            $audience,
            ['description', 'targeting_reference'],
            ['description'],
            'Fact Contract audience_context'
        );
        self::boundedString($audience['description'], 1, 1000, 'Fact Contract audience_context.description');
        if (array_key_exists('targeting_reference', $audience)) {
            self::stableReference($audience['targeting_reference'], 'Fact Contract audience_context.targeting_reference');
        }

        $claim = self::object($input['core_claim'], 'Fact Contract core_claim');
        self::closedObject($claim, ['statement', 'source_block_ids'], ['statement'], 'Fact Contract core_claim');
        self::boundedString($claim['statement'], 1, 2000, 'Fact Contract core_claim.statement');
        if (array_key_exists('source_block_ids', $claim)) {
            self::referenceList($claim['source_block_ids'], 0, 64, 'Fact Contract core_claim.source_block_ids');
        }

        $action = self::object($input['primary_action'], 'Fact Contract primary_action');
        self::closedObject(
            $action,
            ['action_id', 'block_id', 'role', 'label', 'canonical_url'],
            ['action_id', 'block_id', 'role', 'label'],
            'Fact Contract primary_action'
        );
        self::stableReference($action['action_id'], 'Fact Contract primary_action.action_id');
        self::stableReference($action['block_id'], 'Fact Contract primary_action.block_id');
        $role = self::enum($action['role'], self::PRIMARY_ACTION_ROLES, 'Fact Contract primary_action.role');
        self::boundedString($action['label'], 1, 256, 'Fact Contract primary_action.label');
        if ($role === 'reply') {
            if (array_key_exists('canonical_url', $action)) {
                throw new \InvalidArgumentException('Fact Contract reply primary action must not include canonical_url');
            }
        } else {
            if (!array_key_exists('canonical_url', $action)) {
                throw new \InvalidArgumentException('Fact Contract non-reply primary action requires canonical_url');
            }
            self::uri($action['canonical_url'], 'Fact Contract primary_action.canonical_url');
        }

        $facts = self::list($input['required_facts'], 'Fact Contract required_facts');
        if (count($facts) > 128) {
            throw new \InvalidArgumentException('Fact Contract required_facts accepts at most 128 items');
        }
        $factIds = [];
        foreach ($facts as $index => $rawFact) {
            $fact = self::object($rawFact, "Fact Contract required_facts[$index]");
            self::validateRequiredFact($fact, $index);
            $id = (string) $fact['id'];
            if (isset($factIds[$id])) {
                throw new \InvalidArgumentException("Fact Contract required_facts contains duplicate id $id");
            }
            $factIds[$id] = true;
        }

        $claims = self::list($input['forbidden_claims'], 'Fact Contract forbidden_claims');
        if (count($claims) > 64) {
            throw new \InvalidArgumentException('Fact Contract forbidden_claims accepts at most 64 items');
        }
        $claimIds = [];
        foreach ($claims as $index => $rawForbidden) {
            $forbidden = self::object($rawForbidden, "Fact Contract forbidden_claims[$index]");
            self::closedObject(
                $forbidden,
                ['id', 'statement'],
                ['id', 'statement'],
                "Fact Contract forbidden_claims[$index]"
            );
            self::stableReference($forbidden['id'], "Fact Contract forbidden_claims[$index].id");
            self::boundedString($forbidden['statement'], 1, 2000, "Fact Contract forbidden_claims[$index].statement");
            $id = (string) $forbidden['id'];
            if (isset($claimIds[$id])) {
                throw new \InvalidArgumentException("Fact Contract forbidden_claims contains duplicate id $id");
            }
            $claimIds[$id] = true;
        }

        $secondary = self::list($input['allowed_secondary_actions'], 'Fact Contract allowed_secondary_actions');
        if (count($secondary) > 16) {
            throw new \InvalidArgumentException('Fact Contract allowed_secondary_actions accepts at most 16 items');
        }
        self::uniqueEnums($secondary, self::SECONDARY_ACTION_ROLES, 'Fact Contract allowed_secondary_actions');

        $language = self::boundedString($input['language'], 1, 255, 'Fact Contract language');
        if (strcasecmp($language, 'und') === 0 || str_contains($language, '_')) {
            throw new \InvalidArgumentException('Fact Contract language must be a specific canonical BCP 47 tag');
        }

        return $input;
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function createRunInput(array $input): array
    {
        self::closedObject(
            $input,
            [
                'profile',
                'content_revision_id',
                'send_plan_id',
                'request_id',
                'include_seed_test',
                'observed_surfaces',
            ],
            ['profile', 'request_id'],
            'Campaign Assurance run input'
        );
        self::enum($input['profile'], self::PROFILES, 'Campaign Assurance profile');
        self::uuid($input['request_id'], 'Campaign Assurance request_id');
        if (array_key_exists('content_revision_id', $input)) {
            self::uuid($input['content_revision_id'], 'Campaign Assurance content_revision_id');
        }
        if (array_key_exists('send_plan_id', $input)) {
            self::uuid($input['send_plan_id'], 'Campaign Assurance send_plan_id');
            if (!array_key_exists('content_revision_id', $input)) {
                throw new \InvalidArgumentException('Campaign Assurance send_plan_id requires content_revision_id');
            }
        }
        if (array_key_exists('include_seed_test', $input) && !is_bool($input['include_seed_test'])) {
            throw new \InvalidArgumentException('Campaign Assurance include_seed_test must be a boolean');
        }
        if (array_key_exists('observed_surfaces', $input)) {
            if (($input['include_seed_test'] ?? null) !== true) {
                throw new \InvalidArgumentException('Campaign Assurance observed_surfaces is allowed only when include_seed_test is true');
            }
            $surfaces = self::list($input['observed_surfaces'], 'Campaign Assurance observed_surfaces');
            if (count($surfaces) > 32) {
                throw new \InvalidArgumentException('Campaign Assurance observed_surfaces accepts at most 32 items');
            }
            $seen = [];
            foreach ($surfaces as $index => $surface) {
                $value = self::boundedString($surface, 1, 128, "Campaign Assurance observed_surfaces[$index]");
                if (preg_match('/^[A-Za-z0-9._:-]+$/D', $value) !== 1) {
                    throw new \InvalidArgumentException('Campaign Assurance observed_surfaces must contain stable ASCII references');
                }
                if (isset($seen[$value])) {
                    throw new \InvalidArgumentException('Campaign Assurance observed_surfaces must be unique');
                }
                $seen[$value] = true;
            }
        }

        return $input;
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function appealInput(array $input): array
    {
        self::closedObject(
            $input,
            ['request_id', 'decision', 'reason', 'expires_at'],
            ['request_id', 'decision', 'reason'],
            'Campaign Assurance appeal input'
        );
        self::uuid($input['request_id'], 'Campaign Assurance appeal request_id');
        self::enum($input['decision'], self::APPEAL_DECISIONS, 'Campaign Assurance appeal decision');
        $reason = self::boundedString($input['reason'], 1, 2000, 'Campaign Assurance appeal reason');
        $normalized = preg_replace('/^\s+|\s+$/u', '', $reason);
        if ($normalized === null || self::utf8Length($normalized, 'Campaign Assurance appeal reason') < 10) {
            throw new \InvalidArgumentException('Campaign Assurance appeal reason must contain 10-2000 characters after trimming');
        }
        if (array_key_exists('expires_at', $input)) {
            self::timestamp($input['expires_at'], 'Campaign Assurance appeal expires_at');
        }
        return $input;
    }

    /**
     * Project the one-field public body. Caller-authored patch instructions
     * are never transported, even if the input originated in untyped PHP.
     *
     * @param array<string, mixed> $input
     * @return array{request_id: string}
     */
    public static function applyFindingInput(array $input): array
    {
        if (!array_key_exists('request_id', $input)) {
            throw new \InvalidArgumentException('Campaign Assurance apply input requires request_id');
        }
        return ['request_id' => self::uuid($input['request_id'], 'Campaign Assurance apply request_id')];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, int>
     */
    public static function evidenceQuery(array $input): array
    {
        self::closedObject($input, ['limit', 'offset'], [], 'Campaign Assurance evidence options');
        $query = [];
        if (array_key_exists('limit', $input)) {
            if (!is_int($input['limit']) || $input['limit'] < 1 || $input['limit'] > 200) {
                throw new \InvalidArgumentException('Campaign Assurance evidence limit must be an integer between 1 and 200');
            }
            $query['limit'] = $input['limit'];
        }
        if (array_key_exists('offset', $input)) {
            if (!is_int($input['offset']) || $input['offset'] < 0 || $input['offset'] > 100000) {
                throw new \InvalidArgumentException('Campaign Assurance evidence offset must be an integer between 0 and 100000');
            }
            $query['offset'] = $input['offset'];
        }
        return $query;
    }

    public static function pathSegment(string $value, string $label): string
    {
        if ($value === '' || trim($value) === '' || preg_match('//u', $value) !== 1) {
            throw new \InvalidArgumentException("Campaign Assurance $label is required");
        }
        return rawurlencode($value);
    }

    public static function strongETag(string $value): string
    {
        $validUtf8 = preg_match('//u', $value) === 1;
        $inner = strlen($value) >= 2 ? substr($value, 1, -1) : '';
        if (
            !$validUtf8
            || $value !== trim($value)
            || strlen($value) < 3
            || strlen($value) > 512
            || $value === '*'
            || str_starts_with($value, 'W/')
            || !str_starts_with($value, '"')
            || !str_ends_with($value, '"')
            || $inner === ''
            || str_contains($inner, '"')
            || str_contains($value, ',')
            || preg_match('/[\x{0000}-\x{001F}\x{007F}-\x{009F}]/u', $value) === 1
        ) {
            throw new \InvalidArgumentException(
                'ifMatch must be the exact strong campaign ETag returned by the API'
            );
        }
        return $value;
    }

    public static function idempotencyKey(?string $value): string
    {
        if ($value === null) {
            return self::uuidV4();
        }
        $trimmed = preg_replace('/^\s+|\s+$/u', '', $value);
        if (
            $trimmed === null
            || $value === ''
            || $value !== $trimmed
            || strlen($value) > 255
            || preg_match('//u', $value) !== 1
            || preg_match('/[\x{0000}-\x{001F}\x{007F}-\x{009F}]/u', $value) === 1
        ) {
            throw new \InvalidArgumentException(
                'idempotencyKey must be 1-255 UTF-8 bytes without surrounding whitespace or control characters'
            );
        }
        return $value;
    }

    /** @return array{Idempotency-Key: string} */
    public static function mutationHeaders(?string $idempotencyKey): array
    {
        return ['Idempotency-Key' => self::idempotencyKey($idempotencyKey)];
    }

    /** @param array<string, mixed> $fact */
    private static function validateRequiredFact(array $fact, int $index): void
    {
        $label = "Fact Contract required_facts[$index]";
        self::closedObject(
            $fact,
            [
                'id',
                'type',
                'display_value',
                'criticality',
                'source_block_ids',
                'text_value',
                'datetime_value',
                'money_value',
                'number_value',
                'url_value',
            ],
            ['id', 'type', 'display_value', 'criticality', 'source_block_ids'],
            $label
        );
        self::stableReference($fact['id'], "$label.id");
        $type = self::enum($fact['type'], self::FACT_TYPES, "$label.type");
        self::boundedString($fact['display_value'], 1, 1000, "$label.display_value");
        self::enum($fact['criticality'], self::CRITICALITIES, "$label.criticality");
        self::referenceList($fact['source_block_ids'], 1, 64, "$label.source_block_ids");

        $expectedValueField = match ($type) {
            'text', 'location', 'code' => 'text_value',
            'datetime' => 'datetime_value',
            'money' => 'money_value',
            'percentage', 'quantity' => 'number_value',
            'url' => 'url_value',
        };
        $valueFields = ['text_value', 'datetime_value', 'money_value', 'number_value', 'url_value'];
        $present = array_values(array_filter(
            $valueFields,
            static fn(string $field): bool => array_key_exists($field, $fact)
        ));
        if ($present !== [$expectedValueField]) {
            throw new \InvalidArgumentException(
                "$label must contain exactly the typed value field required by type=$type"
            );
        }

        if ($expectedValueField === 'text_value') {
            self::boundedString($fact['text_value'], 1, 2000, "$label.text_value");
            return;
        }
        if ($expectedValueField === 'url_value') {
            self::uri($fact['url_value'], "$label.url_value");
            return;
        }
        if ($expectedValueField === 'datetime_value') {
            $datetime = self::object($fact['datetime_value'], "$label.datetime_value");
            self::closedObject(
                $datetime,
                ['rfc3339', 'timezone'],
                ['rfc3339', 'timezone'],
                "$label.datetime_value"
            );
            $instant = self::timestamp($datetime['rfc3339'], "$label.datetime_value.rfc3339");
            $timezone = self::boundedString($datetime['timezone'], 1, 255, "$label.datetime_value.timezone");
            try {
                $zone = new \DateTimeZone($timezone);
            } catch (\Exception) {
                throw new \InvalidArgumentException("$label.datetime_value.timezone must be an IANA time-zone name");
            }
            if ($zone->getOffset($instant) !== $instant->getOffset()) {
                throw new \InvalidArgumentException("$label.datetime_value timezone must match the RFC3339 offset");
            }
            return;
        }
        if ($expectedValueField === 'money_value') {
            $money = self::object($fact['money_value'], "$label.money_value");
            self::closedObject($money, ['amount', 'currency'], ['amount', 'currency'], "$label.money_value");
            self::decimal($money['amount'], "$label.money_value.amount");
            $currency = self::boundedString($money['currency'], 3, 3, "$label.money_value.currency");
            if (preg_match('/^[A-Z]{3}$/D', $currency) !== 1 || in_array($currency, ['XXX', 'XTS'], true)) {
                throw new \InvalidArgumentException("$label.money_value.currency must be a concrete ISO 4217 code");
            }
            return;
        }

        $number = self::object($fact['number_value'], "$label.number_value");
        self::closedObject($number, ['value', 'unit'], ['value'], "$label.number_value");
        $value = self::decimal($number['value'], "$label.number_value.value");
        if ($type === 'percentage') {
            if (!array_key_exists('unit', $number) || $number['unit'] !== '%' || (float) $value < 0 || (float) $value > 100) {
                throw new \InvalidArgumentException("$label percentage must be between 0 and 100 with unit %");
            }
        } elseif (
            !array_key_exists('unit', $number)
            || (float) $value < 0
            || self::boundedString($number['unit'], 1, 64, "$label.number_value.unit") === ''
        ) {
            throw new \InvalidArgumentException("$label quantity must be nonnegative and include a unit");
        }
        if (array_key_exists('unit', $number)) {
            self::boundedString($number['unit'], 1, 64, "$label.number_value.unit");
        }
    }

    /**
     * @param array<string, mixed> $value
     * @param list<string> $allowed
     * @param list<string> $required
     */
    private static function closedObject(array $value, array $allowed, array $required, string $label): void
    {
        foreach (array_keys($value) as $key) {
            if (!is_string($key) || !in_array($key, $allowed, true)) {
                throw new \InvalidArgumentException("$label contains an unsupported field");
            }
        }
        foreach ($required as $key) {
            if (!array_key_exists($key, $value)) {
                throw new \InvalidArgumentException("$label requires $key");
            }
        }
    }

    /** @return array<string, mixed> */
    private static function object(mixed $value, string $label): array
    {
        if (!is_array($value) || ($value !== [] && array_is_list($value))) {
            throw new \InvalidArgumentException("$label must be an object");
        }
        return $value;
    }

    /** @return list<mixed> */
    private static function list(mixed $value, string $label): array
    {
        if (!is_array($value) || !array_is_list($value)) {
            throw new \InvalidArgumentException("$label must be a list");
        }
        return $value;
    }

    /** @param list<string> $allowed */
    private static function enum(mixed $value, array $allowed, string $label): string
    {
        if (!is_string($value) || !in_array($value, $allowed, true)) {
            throw new \InvalidArgumentException("$label is not an allowed value");
        }
        return $value;
    }

    private static function boundedString(mixed $value, int $minimum, int $maximum, string $label): string
    {
        if (!is_string($value)) {
            throw new \InvalidArgumentException("$label must be a string");
        }
        $length = self::utf8Length($value, $label);
        if ($length < $minimum || $length > $maximum) {
            throw new \InvalidArgumentException("$label must contain $minimum-$maximum Unicode characters");
        }
        return $value;
    }

    private static function utf8Length(string $value, string $label): int
    {
        $count = preg_match_all('/./us', $value, $matches);
        if ($count === false) {
            throw new \InvalidArgumentException("$label must be valid UTF-8");
        }
        return $count;
    }

    private static function stableReference(mixed $value, string $label): string
    {
        $reference = self::boundedString($value, 1, 128, $label);
        if (preg_match('/^[A-Za-z0-9._:-]+$/D', $reference) !== 1) {
            throw new \InvalidArgumentException("$label must be a stable ASCII reference");
        }
        return $reference;
    }

    private static function uuid(mixed $value, string $label): string
    {
        if (!is_string($value) || preg_match(
            '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/Di',
            $value
        ) !== 1) {
            throw new \InvalidArgumentException("$label must be a canonical UUID");
        }
        return $value;
    }

    private static function uri(mixed $value, string $label): string
    {
        $uri = self::boundedString($value, 1, 4096, $label);
        if (
            preg_match('/^[A-Za-z][A-Za-z0-9+.-]*:/D', $uri) !== 1
            || preg_match('/[\x{0000}-\x{0020}\x{007F}-\x{009F}]/u', $uri) === 1
        ) {
            throw new \InvalidArgumentException("$label must be an absolute URI");
        }
        return $uri;
    }

    private static function timestamp(mixed $value, string $label): \DateTimeImmutable
    {
        if (
            !is_string($value)
            || preg_match(
                '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D',
                $value
            ) !== 1
        ) {
            throw new \InvalidArgumentException("$label must be an RFC3339 timestamp");
        }
        try {
            return new \DateTimeImmutable($value);
        } catch (\Exception) {
            throw new \InvalidArgumentException("$label must be an RFC3339 timestamp");
        }
    }

    private static function decimal(mixed $value, string $label): string
    {
        if (!is_string($value) || preg_match('/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/D', $value) !== 1) {
            throw new \InvalidArgumentException("$label must be a canonical base-10 decimal string");
        }
        $unsigned = ltrim($value, '-');
        [$whole, $fraction] = array_pad(explode('.', $unsigned, 2), 2, '');
        if (strlen($whole . $fraction) > 38 || strlen($fraction) > 9) {
            throw new \InvalidArgumentException("$label accepts at most 38 digits and 9 fractional digits");
        }
        return $value;
    }

    private static function referenceList(mixed $value, int $minimum, int $maximum, string $label): void
    {
        $references = self::list($value, $label);
        if (count($references) < $minimum || count($references) > $maximum) {
            throw new \InvalidArgumentException("$label accepts $minimum-$maximum items");
        }
        $seen = [];
        foreach ($references as $index => $reference) {
            $normalized = self::stableReference($reference, "$label[$index]");
            if (isset($seen[$normalized])) {
                throw new \InvalidArgumentException("$label must contain unique references");
            }
            $seen[$normalized] = true;
        }
    }

    /** @param list<mixed> $values @param list<string> $allowed */
    private static function uniqueEnums(array $values, array $allowed, string $label): void
    {
        $seen = [];
        foreach ($values as $index => $value) {
            $normalized = self::enum($value, $allowed, "$label[$index]");
            if (isset($seen[$normalized])) {
                throw new \InvalidArgumentException("$label must contain unique values");
            }
            $seen[$normalized] = true;
        }
    }

    private static function uuidV4(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8)
            . '-' . substr($hex, 8, 4)
            . '-' . substr($hex, 12, 4)
            . '-' . substr($hex, 16, 4)
            . '-' . substr($hex, 20, 12);
    }
}
