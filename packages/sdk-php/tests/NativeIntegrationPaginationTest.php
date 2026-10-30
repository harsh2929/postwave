<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Resources\NativeIntegrationFamilyResource;

final class NativeIntegrationPaginationTest extends TestCase
{
    /** @return iterable<string, array{0: array<string, mixed>}> */
    public static function invalidSupportListOptions(): iterable
    {
        yield 'zero limit' => [['limit' => 0]];
        yield 'limit above maximum' => [['limit' => 101]];
        yield 'fractional limit' => [['limit' => 1.5]];
        yield 'numeric string limit' => [['limit' => '50']];
        yield 'boolean limit' => [['limit' => true]];
        yield 'numeric cursor' => [['cursor' => 123]];
        yield 'empty cursor' => [['cursor' => '']];
        yield 'leading cursor whitespace' => [['cursor' => ' cursor']];
        yield 'trailing cursor whitespace' => [['cursor' => "cursor\n"]];
        yield 'cursor control' => [['cursor' => "opaque\0cursor"]];
        yield 'cursor bidi marker' => [['cursor' => "opaque\u{202E}cursor"]];
        yield 'cursor invalid utf8' => [['cursor' => "opaque\xFFcursor"]];
        yield 'oversized cursor' => [['cursor' => str_repeat('x', 4097)]];
        yield 'unknown query field' => [['page' => 2]];
    }

    #[DataProvider('invalidSupportListOptions')]
    public function testSupportListRejectsInvalidOptionsBeforeTransport(array $options): void
    {
        $client = new Client('pw_test_support_paging', 'http://127.0.0.1:1');

        $this->expectException(\InvalidArgumentException::class);
        $client->nativeIntegrations->support->list($options);
    }

    public function testNonSupportFamiliesRejectSupportPagination(): void
    {
        $client = new Client('pw_test_support_paging', 'http://127.0.0.1:1');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('available only for support integrations');
        $client->nativeIntegrations->crm->list(['limit' => 10]);
    }

    public function testSupportListNormalizesFirstAndOpaqueNextPagesForClientEncoding(): void
    {
        $normalize = new \ReflectionMethod(
            NativeIntegrationFamilyResource::class,
            'supportListQuery'
        );
        $firstQuery = $normalize->invoke(null, []);
        $cursor = 'opaque+/=?&%cursor';
        $nextQuery = $normalize->invoke(null, [
            'cursor' => $cursor,
            'limit' => 17,
        ]);

        $this->assertSame([], $firstQuery);
        $this->assertSame(['limit' => 17, 'cursor' => $cursor], $nextQuery);
        $this->assertSame(
            'limit=17&cursor=opaque%2B%2F%3D%3F%26%25cursor',
            http_build_query($nextQuery)
        );
        $source = file_get_contents(
            dirname(__DIR__) . '/src/Resources/NativeIntegrationFamilyResource.php'
        );
        $this->assertIsString($source);
        $this->assertMatchesRegularExpression(
            '~request\(\x27GET\x27, \$this->integrationsPath, null, \$query\)~',
            $source
        );
        $readme = file_get_contents(dirname(__DIR__) . '/README.md');
        $this->assertIsString($readme);
        $this->assertStringContainsString(
            "support->list(['limit' => 50, 'cursor' => \$opaqueCursor])",
            $readme
        );
        $this->assertStringContainsString('support_integration_runtime_held', $readme);
    }
}
