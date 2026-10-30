<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Client;

final class NativeIntegrationsResource
{
    public CommerceNativeIntegrationsResource $commerce;
    public NativeIntegrationFamilyResource $crm;
    public NativeIntegrationFamilyResource $lead;
    public NativeIntegrationFamilyResource $reviews;
    public NativeIntegrationFamilyResource $loyalty;
    public NativeIntegrationFamilyResource $subscriptions;
    public NativeIntegrationFamilyResource $support;
    public NativeIntegrationFamilyResource $analytics;
    public NativeIntegrationFamilyResource $marketing;
    public WarehouseNativeIntegrationsResource $warehouse;

    public function __construct(Client $client)
    {
        $this->commerce = new CommerceNativeIntegrationsResource($client);
        $this->crm = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/crm/providers',
            '/api/v1/crm/integrations'
        );
        $this->lead = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/lead-integrations/providers',
            '/api/v1/lead-integrations',
            true
        );
        $this->reviews = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/review-integrations/providers',
            '/api/v1/review-integrations',
            true
        );
        $this->loyalty = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/loyalty-integrations/providers',
            '/api/v1/loyalty-integrations',
            true
        );
        $this->subscriptions = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/subscription-integrations/providers',
            '/api/v1/subscription-integrations',
            true
        );
        $this->support = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/support-integrations/providers',
            '/api/v1/support-integrations',
            true,
            NativeIntegrationFamilyResource::SUPPORT_INTEGRATION_RUNTIME_HELD_CODE
        );
        $this->analytics = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/analytics-integrations/providers',
            '/api/v1/analytics-integrations',
            true
        );
        $this->marketing = new NativeIntegrationFamilyResource(
            $client,
            '/api/v1/marketing-integrations/providers',
            '/api/v1/marketing-integrations'
        );
        $this->warehouse = new WarehouseNativeIntegrationsResource($client);
    }
}
