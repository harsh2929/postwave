<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\GiftSubscriptionsResource;

/** The PHP SDK must expose only the sanitized Gift history archive reads. */
final class GiftSubscriptionsResourceContractTest extends TestCase
{
    private static function reflection(): \ReflectionClass
    {
        return new \ReflectionClass(GiftSubscriptionsResource::class);
    }

    private static function source(): string
    {
        return file_get_contents(self::reflection()->getFileName());
    }

    /** @param array<string, mixed> $params */
    private static function normalize(array $params): array
    {
        $method = new \ReflectionMethod(GiftSubscriptionsResource::class, 'normalizeListQuery');

        return $method->invoke(null, $params);
    }

    private static function canonicalId(string $id): string
    {
        $method = new \ReflectionMethod(GiftSubscriptionsResource::class, 'canonicalGiftId');

        return $method->invoke(null, $id);
    }

    /** @return array<string, mixed> */
    private static function requireEnvelope(mixed $value, string $operation): array
    {
        $method = new \ReflectionMethod(GiftSubscriptionsResource::class, 'requireArrayEnvelope');

        return $method->invoke(null, $value, $operation);
    }

    public function testClientExposesGiftHistoryResource(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(GiftSubscriptionsResource::class, $client->giftSubscriptions);
    }

    public function testSurfaceContainsExactlyTheThreeReadMethods(): void
    {
        $methods = array_map(
            static fn (\ReflectionMethod $method): string => $method->getName(),
            array_filter(
                self::reflection()->getMethods(\ReflectionMethod::IS_PUBLIC),
                static fn (\ReflectionMethod $method): bool =>
                    $method->getDeclaringClass()->getName() === GiftSubscriptionsResource::class
            )
        );
        sort($methods);

        $this->assertSame(['get', 'list', 'stats'], $methods);
        $this->assertSame(3, substr_count(self::source(), "'GET'"));
        foreach (["'POST'", "'PUT'", "'PATCH'", "'DELETE'"] as $verb) {
            $this->assertStringNotContainsString($verb, self::source());
        }
    }

    public function testListForwardsTheBoundedArchiveParameters(): void
    {
        $method = new \ReflectionMethod(GiftSubscriptionsResource::class, 'list');
        $parameter = $method->getParameters()[0];
        $docs = $method->getDocComment();

        $this->assertSame('params', $parameter->getName());
        $this->assertSame([], $parameter->getDefaultValue());
        $this->assertStringContainsString('int<1, 100>', $docs);
        $this->assertStringContainsString('int<0, 10000>', $docs);
        foreach (['q?:', 'filter?:', 'sort?:'] as $field) {
            $this->assertStringContainsString($field, $docs);
        }
        $this->assertStringContainsString(
            "array_fill_keys(['limit', 'offset', 'q', 'filter', 'sort'], true)",
            self::source()
        );
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'GET',\\s*'\\/api\\/v1\\/gift-subscriptions',\\s*null,\\s*\\\$query\\s*\\)/",
            self::source()
        );
    }

    public function testListNormalizesOnlyCompactOpaqueSearchAndAllowedParameters(): void
    {
        $this->assertSame(
            [
                'limit' => 100,
                'offset' => 10000,
                'q' => 'a1b2c3d4',
                'filter' => 'closed',
                'sort' => 'status',
            ],
            self::normalize([
                'limit' => 100,
                'offset' => 10000,
                'q' => ' Gift record A1B2-C3D4 ',
                'filter' => 'closed',
                'sort' => 'status',
                'recipient_email' => 'must-not-forward@example.com',
            ])
        );
        $this->assertSame([], self::normalize([
            'q' => '   ',
            'filter' => 'all',
            'sort' => 'newest',
        ]));
    }

    public function testListRejectsInvalidSearchAndPaginationBeforeTransport(): void
    {
        $invalidParams = [
            ['q' => 'person@example.com'],
            ['q' => '1234567'],
            ['q' => str_repeat('f', 33)],
            ['q' => 12345678],
            ['limit' => 0],
            ['limit' => 101],
            ['limit' => 1.5],
            ['limit' => true],
            ['offset' => -1],
            ['offset' => 10001],
            ['filter' => 'person@example.com'],
            ['filter' => ['closed']],
            ['sort' => 'random'],
            ['sort' => false],
        ];

        foreach ($invalidParams as $params) {
            try {
                self::normalize($params);
                $this->fail('Expected invalid Gift history list parameters to be rejected');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('Gift history', $error->getMessage());
            }
        }
    }

    public function testStatsAndEncodedDetailUseTheCanonicalRoutes(): void
    {
        $source = self::source();

        $this->assertStringContainsString(
            "\$this->client->request('GET', '/api/v1/gift-subscriptions/stats')",
            $source
        );
        $this->assertMatchesRegularExpression(
            "/request\\(\\s*'GET',\\s*'\\/api\\/v1\\/gift-subscriptions\\/'\\s*\\.\\s*rawurlencode\\(\\\$giftId\\)\\s*\\)/",
            $source
        );
    }

    public function testDetailRequiresCanonicalUuidBeforeTransport(): void
    {
        $this->assertSame(
            'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
            self::canonicalId('A1B2C3D4-E5F6-7890-ABCD-EF0123456789')
        );

        $client = new Client('pw_test_no_transport', 'http://127.0.0.1:1', 1);
        foreach ([
            '',
            'gift/part one',
            'a1b2c3d4e5f67890abcdef0123456789',
            'a1b2c3d4-e5f6-7890-abcd-ef012345678',
            ' a1b2c3d4-e5f6-7890-abcd-ef0123456789',
            'person@example.com',
        ] as $id) {
            try {
                $client->giftSubscriptions->get($id);
                $this->fail('Expected an invalid Gift history id to be rejected before transport');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('canonical UUID', $error->getMessage());
            }
        }
    }

    public function testMalformedResponseEnvelopesAreNeverCoercedToEmptyArrays(): void
    {
        $this->assertSame(['items' => []], self::requireEnvelope(['items' => []], 'list'));

        foreach ([null, false, 0, '', '[]', new \stdClass()] as $value) {
            try {
                self::requireEnvelope($value, 'detail');
                $this->fail('Expected a malformed Gift history response to be rejected');
            } catch (\UnexpectedValueException $error) {
                $this->assertStringContainsString(
                    'Gift history detail response must be a JSON object',
                    $error->getMessage()
                );
            }
        }
        $this->assertStringNotContainsString(
            'is_array($out) ? $out : []',
            self::source()
        );
        foreach (['list', 'stats', 'detail'] as $operation) {
            $this->assertStringContainsString(
                "requireArrayEnvelope(\$out, '$operation')",
                self::source()
            );
        }
    }

    public function testDocumentedShapesContainOnlyTheMinimizedProjection(): void
    {
        $source = self::source();
        foreach ([
            'id:',
            'label:',
            'plan_label:',
            'duration_months:',
            'status:',
            'created_at:',
            'redeemed_at:',
            'expires_at:',
            'canceled_at:',
            'message_recorded:',
            'provider_invoice_linked:',
            'gifter_member_linked:',
            'recipient_member_linked:',
        ] as $field) {
            $this->assertStringContainsString($field, $source);
        }
        foreach ([
            'tenant_id',
            'purchaser_email',
            'recipient_email',
            'cancellation_reason',
            'stripe_invoice_id',
            'payment_url',
            'redemption_token',
            'subscriber_id',
            'attribution',
        ] as $forbiddenField) {
            $this->assertStringNotContainsString($forbiddenField, $source);
        }
    }
}
