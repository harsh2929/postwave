<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Tests;

use PHPUnit\Framework\TestCase;
use Moosewave\Client;
use Moosewave\Errors\ServerError;
use Moosewave\Resources\AnalyticsResource;
use Moosewave\Resources\APIKeysResource;
use Moosewave\Resources\AudienceDestinationsResource;
use Moosewave\Resources\AudienceSyncsResource;
use Moosewave\Resources\AutomationsResource;
use Moosewave\Resources\ChatIntegrationChannelResource;
use Moosewave\Resources\ChatIntegrationsResource;
use Moosewave\Resources\CustomDomainsResource;
use Moosewave\Resources\ConversionIngestSecretsResource;
use Moosewave\Resources\InboundWebhooksResource;
use Moosewave\Resources\NativeIntegrationFamilyResource;
use Moosewave\Resources\SequencesResource;
use Moosewave\Resources\SmsResource;
use Moosewave\Resources\SuppressionsResource;
use Moosewave\Resources\TemplatePreviewResource;
use Moosewave\Resources\TemplatesResource;

final class ClientResourceSurfaceTest extends TestCase
{
    public function testClientExposesFirstPartyIntegrationResources(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(AudienceDestinationsResource::class, $client->audienceDestinations);
        $this->assertInstanceOf(AudienceSyncsResource::class, $client->audienceSyncs);
        $this->assertInstanceOf(ChatIntegrationsResource::class, $client->chatIntegrations);
        $this->assertInstanceOf(ChatIntegrationChannelResource::class, $client->discordIntegrations);
        $this->assertInstanceOf(ChatIntegrationChannelResource::class, $client->teamsIntegrations);
        $this->assertInstanceOf(SmsResource::class, $client->sms);
        $this->assertInstanceOf(APIKeysResource::class, $client->apiKeys);
        $this->assertInstanceOf(InboundWebhooksResource::class, $client->inboundWebhooks);
        $this->assertInstanceOf(
            ConversionIngestSecretsResource::class,
            $client->conversionIngestSecrets
        );
    }

    public function testClientExposesReportingAndLifecycleResources(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(AnalyticsResource::class, $client->analytics);
        $this->assertInstanceOf(SequencesResource::class, $client->sequences);
        $this->assertInstanceOf(AutomationsResource::class, $client->automations);
        $this->assertInstanceOf(SuppressionsResource::class, $client->suppressions);
        $this->assertInstanceOf(CustomDomainsResource::class, $client->customDomains);
        $this->assertInstanceOf(TemplatesResource::class, $client->templates);
        $this->assertInstanceOf(TemplatePreviewResource::class, $client->templatePreview);
    }

    public function testNativeMarketingFamilyDoesNotExposeIngestSupport(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(NativeIntegrationFamilyResource::class, $client->nativeIntegrations->marketing);

        $supportsIngest = new \ReflectionProperty(NativeIntegrationFamilyResource::class, 'supportsIngest');

        $this->assertFalse($supportsIngest->getValue($client->nativeIntegrations->marketing));
        $this->assertTrue($supportsIngest->getValue($client->nativeIntegrations->lead));
    }

    public function testNativeSupportEffectsAreStableLocalReleaseHolds(): void
    {
        $client = new Client('pw_test_resource_surface');
        $support = $client->nativeIntegrations->support;
        $effects = [
            static fn() => $support->create(['provider' => 'zendesk']),
            static fn() => $support->sync('private-id', []),
            static fn() => $support->backfill('private-id', []),
            static fn() => $support->ingest('private-id', ['secret' => 'raw']),
            static fn() => $support->pause('private-id'),
            static fn() => $support->disconnect('private-id'),
            static fn() => $support->acknowledgeProviderCleanup('private-id', []),
            static fn() => $support->runs('private-run-id', 0),
        ];

        foreach ($effects as $effect) {
            try {
                $effect();
                $this->fail('support runtime effect should be release-held');
            } catch (ServerError $error) {
                $this->assertSame(503, $error->status);
                $this->assertSame(
                    NativeIntegrationFamilyResource::SUPPORT_INTEGRATION_RUNTIME_HELD_CODE,
                    $error->code
                );
            }
        }

        try {
            $support->get('support/1');
            $this->fail('support read IDs must be canonical UUIDs');
        } catch (\InvalidArgumentException $error) {
            $this->assertStringContainsString('canonical UUID', $error->getMessage());
        }
    }

    public function testNativeCrmFamilyExposesManagedOAuthHelpers(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertTrue(method_exists($client->nativeIntegrations->crm, 'oauthAvailability'));
        $this->assertSame(
            '/api/v1/crm/salesforce/oauth/start?name=Salesforce%20production&sync_tasks=false&redirect_to=%2Fapp%2Fintegrations',
            $client->nativeIntegrations->crm->oauthStartUrl('salesforce', [
                'name' => 'Salesforce production',
                'sync_tasks' => false,
                'redirect_to' => '/app/integrations',
            ])
        );
    }

    public function testNativeNonCrmFamiliesRejectManagedOAuthHelpers(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('managed CRM OAuth');

        $client->nativeIntegrations->marketing->oauthStartUrl('salesforce');
    }

    public function testNativeWarehouseFamilyExposesProviderCleanupAcknowledgement(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertTrue(method_exists($client->nativeIntegrations->warehouse, 'acknowledgeProviderCleanup'));
    }

    public function testNativeSubscriptionFamilyExposesProviderCleanupAcknowledgement(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertTrue(method_exists($client->nativeIntegrations->subscriptions, 'acknowledgeProviderCleanup'));
    }

    public function testNativeMarketingFamilyExposesProviderCleanupAcknowledgement(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertTrue(method_exists($client->nativeIntegrations->marketing, 'acknowledgeProviderCleanup'));
    }

    public function testSubscribersResourceExposesWriteAndSearchSurface(): void
    {
        $client = new Client('pw_test_resource_surface');

        foreach ([
            'update',
            'delete',
            'search',
            'importCsv',
            'exportCsv',
            'merge',
            'transformRules',
            'upsertTransformRule',
            'deleteTransformRule',
        ] as $method) {
            $this->assertTrue(
                method_exists($client->subscribers, $method),
                "SubscribersResource is missing $method()"
            );
        }
    }

    public function testMigrationUploadStatusAndCrmOauthProviderAllowlist(): void
    {
        $client = new Client('pw_test_resource_surface');
        $this->assertTrue(method_exists($client->migrations, 'uploadStatus'));

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Unsupported CRM OAuth provider');
        $client->nativeIntegrations->crm->oauthStartUrl('../../admin');
    }

    public function testChatProviderAccessorReturnsAutoloadableChannelResource(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->assertInstanceOf(ChatIntegrationChannelResource::class, $client->chatIntegrations->slack);
        $this->assertSame(
            $client->chatIntegrations->discord,
            $client->discordIntegrations
        );
        $this->assertSame(
            $client->chatIntegrations->discord,
            $client->chatIntegrations->forProvider('discord')
        );
    }

    public function testChatProviderAccessorRejectsUnknownProviders(): void
    {
        $client = new Client('pw_test_resource_surface');

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('unsupported chat integration provider');

        $client->chatIntegrations->forProvider('irc');
    }
}
