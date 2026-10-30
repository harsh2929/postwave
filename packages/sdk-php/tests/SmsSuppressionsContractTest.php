<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Errors\PostwaveError;
use Moosewave\Resources\SmsResource;

final class SmsSuppressionsContractTest extends TestCase
{
    private const TENANT = '00000000-0000-0000-0000-000000000001';

    /** @return array<string, mixed> */
    private static function row(array $overrides = []): array
    {
        return [
            'id' => '33333333-3333-4333-8333-333333333333',
            'phone_e164' => '+12025550101',
            'reason' => 'manual',
            'source' => 'manual',
            'created_at' => '2026-08-28T09:00:00Z',
            'reversible' => true,
            ...$overrides,
        ];
    }

    public function testSurfaceUsesBodyQueryForSensitivePhone(): void
    {
        foreach (['listSuppressions', 'addSuppression', 'removeSuppression'] as $method) {
            $this->assertTrue(method_exists(SmsResource::class, $method));
        }
        $source = file_get_contents((new \ReflectionClass(SmsResource::class))->getFileName());
        $this->assertStringContainsString("'/api/v1/sms/suppressions/query'", $source);
        $this->assertDoesNotMatchRegularExpression('/suppressions\\?[^\'\"]*phone/', $source);
    }

    public function testStrictPageDecoderAcceptsCanonicalNonV4Tenant(): void
    {
        $decode = new \ReflectionMethod(SmsResource::class, 'decodeSuppressionPage');
        $page = $decode->invoke(null, [
            'tenantId' => self::TENANT,
            'items' => [self::row()],
            'total' => 2,
            'nextCursor' => 'v1.bmV4dA',
            'snapshotAt' => '2026-08-28T10:00:00Z',
        ], self::TENANT, 1);
        $this->assertSame('v1.bmV4dA', $page['nextCursor']);
        $this->assertSame('+12025550101', $page['items'][0]['phone_e164']);
    }

    public function testStrictRowDecoderRejectsInventedAuthority(): void
    {
        $decode = new \ReflectionMethod(SmsResource::class, 'decodeSuppressionRow');
        $this->expectException(PostwaveError::class);
        $decode->invoke(null, self::row([
            'reason' => 'stop_keyword',
            'source' => 'provider_webhook',
            'reversible' => false,
            'locked_reason' => 'support_override',
        ]));
    }

    /** @dataProvider projectionPoison */
    public function testStrictPageDecoderRejectsCursorAndTimePoison(array $poison): void
    {
        $decode = new \ReflectionMethod(SmsResource::class, 'decodeSuppressionPage');
        $this->expectException(PostwaveError::class);
        $decode->invoke(null, [
            'tenantId' => self::TENANT,
            'items' => [self::row()],
            'total' => 1,
            'snapshotAt' => '2026-08-28T10:00:00Z',
            ...$poison,
        ], self::TENANT, 1);
    }

    /** @return iterable<string, array{array<string, mixed>}> */
    public static function projectionPoison(): iterable
    {
        yield 'legacy cursor' => [['nextCursor' => 'opaque', 'total' => 2]];
        yield 'wrong cursor version' => [['nextCursor' => 'v2.token', 'total' => 2]];
        yield 'before projection window' => [['snapshotAt' => '1999-12-31T23:59:59Z']];
        yield 'after projection window' => [['snapshotAt' => '2100-01-01T00:00:00Z']];
        yield 'offset crosses before projection window' => [['snapshotAt' => '2000-01-01T00:00:00+14:00']];
        yield 'offset crosses after projection window' => [['snapshotAt' => '2099-12-31T23:59:59-14:00']];
    }
}
