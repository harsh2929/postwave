<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\AgencyReleaseHeldError;
use Moosewave\Errors\ParseError;
use Moosewave\Resources\AgencyResource;

final class AgencyResourceContractTest extends TestCase
{
    /** @var array<string, mixed> */
    private const CHILD = [
        'id' => '11111111-1111-4111-8111-111111111111',
        'slug' => 'child-one',
        'name' => 'Child One',
        'tier' => 'studio',
        'parent_tenant_id' => '22222222-2222-4222-8222-222222222222',
        'billing_mode' => 'self',
        'reseller_markup_bps' => 0,
        'whitelabel_enabled' => false,
        'created_at' => '2026-09-12T08:00:00Z',
        'updated_at' => '2026-09-12T08:00:01Z',
    ];

    /** @var array<string, mixed> */
    private const BRANDING = [
        'whitelabel_enabled' => false,
        'brand_name' => '',
        'custom_domain' => '',
        'logo_url' => '',
        'primary_color' => '',
        'support_email' => '',
        'legal_entity' => '',
        'updated_at' => '2026-09-12T08:00:01Z',
        'etag' => '"agency-branding:22222222-2222-4222-8222-222222222222:v0"',
    ];

    public function testOnlyTwoBoundedReadsPerformTransport(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
        $server = LoopbackJsonServer::start([
            ['body' => ['children' => [self::CHILD], 'count' => 1, 'has_more' => true, 'next_cursor' => 'next_1']],
            ['body' => self::BRANDING],
        ]);
        $client = new Client('pw_agency', "http://127.0.0.1:$server->port", 30, [
            'X-Tenant-ID' => 'parent',
        ]);

        $this->assertSame(1, $client->agency->listChildren(25, 'prior_1')['count']);
        $this->assertSame(self::BRANDING, $client->agency->getBranding());

        $requests = $server->requests();
        $this->assertCount(2, $requests);
        $this->assertSame('GET', $requests[0]['method']);
        $this->assertSame('/api/v1/agency/children?limit=25&cursor=prior_1', $requests[0]['target']);
        $this->assertSame('GET', $requests[1]['method']);
        $this->assertSame('/api/v1/agency/branding', $requests[1]['target']);
    }

    public function testFiveHeldCapabilitiesAreTypedNonRetryableAndRequestFree(): void
    {
        $client = new Client('pw_agency', 'http://127.0.0.1:1', 1);
        $calls = [
            [fn () => $client->agency->createChild(['slug' => 'child', 'name' => 'Child']), AgencyResource::CHILD_CREATE_RELEASE_HELD_CODE],
            [fn () => $client->agency->unlinkChild(self::CHILD['id']), AgencyResource::CHILD_UNLINK_RELEASE_HELD_CODE],
            [fn () => $client->agency->updateBranding(['brand_name' => 'Brand']), AgencyResource::BRANDING_UPDATE_RELEASE_HELD_CODE],
            [fn () => $client->agency->setBillingMode(['target_tenant_id' => self::CHILD['id'], 'mode' => 'self', 'reason' => 'review']), AgencyResource::BILLING_MODE_RELEASE_HELD_CODE],
            [fn () => $client->agency->invoicePreview(), AgencyResource::INVOICE_PREVIEW_RELEASE_HELD_CODE],
        ];

        foreach ($calls as [$call, $code]) {
            try {
                $call();
                $this->fail('Expected the Agency capability to be release-held');
            } catch (AgencyReleaseHeldError $error) {
                $this->assertSame(503, $error->status);
                $this->assertSame($code, $error->getErrorCode());
                $this->assertFalse($error->retryable);
                $this->assertFalse($error->committed);
            }
        }

        $source = file_get_contents((new \ReflectionClass(AgencyResource::class))->getFileName());
        $this->assertSame(2, substr_count($source, '$this->client->request('));
        $this->assertSame(2, substr_count($source, "'GET'"));
        foreach (["'POST'", "'PUT'", "'PATCH'", "'DELETE'"] as $verb) {
            $this->assertStringNotContainsString($verb, $source);
        }
    }

    public function testInvalidPaginationFailsBeforeTransport(): void
    {
        $client = new Client('pw_agency', 'http://127.0.0.1:1', 1);
        foreach ([0, 201] as $limit) {
            try {
                $client->agency->listChildren($limit);
                $this->fail('Expected invalid Agency roster limit');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('limit', $error->getMessage());
            }
        }
        foreach (['', 'with space', str_repeat('x', 513)] as $cursor) {
            try {
                $client->agency->listChildren(null, $cursor);
                $this->fail('Expected invalid Agency roster cursor');
            } catch (\InvalidArgumentException $error) {
                $this->assertStringContainsString('cursor', $error->getMessage());
            }
        }
    }

    public function testUnsafeBrandingHostsAndOversizedRequestedPagesFailClosed(): void
    {
        if (!function_exists('pcntl_fork') || !function_exists('stream_socket_server')) {
            $this->markTestSkipped('requires pcntl + stream sockets');
        }
        $second = self::CHILD;
        $second['id'] = '33333333-3333-4333-8333-333333333333';
        $server = LoopbackJsonServer::start([
            ['body' => ['children' => [self::CHILD, $second], 'count' => 2, 'has_more' => false]],
            ['body' => array_merge(self::BRANDING, ['custom_domain' => '127.1'])],
        ]);
        $client = new Client('pw_agency', "http://127.0.0.1:$server->port", 30);

        try {
            $client->agency->listChildren(1);
            $this->fail('Expected the requested roster page bound to fail closed');
        } catch (ParseError $error) {
            $this->assertStringContainsString('page bound', $error->getMessage());
        }
        try {
            $client->agency->getBranding();
            $this->fail('Expected the browser-interpreted IP host to fail closed');
        } catch (ParseError $error) {
            $this->assertStringContainsString('branding', $error->getMessage());
        }
    }
}
