<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/**
 * Thrown on HTTP 421. The tenant's data lives in a different region;
 * `correctEndpoint` is the SDK host to retry against.
 *
 *     try { $pw->subscribers->list(); }
 *     catch (WrongRegionError $e) {
 *         $eu = new \Moosewave\Client(apiKey: ..., baseUrl: $e->correctEndpoint);
 *         return $eu->subscribers->list();
 *     }
 */
class WrongRegionError extends PostwaveError
{
    public function __construct(
        string $message,
        string $code,
        public readonly string $correctEndpoint,
        public readonly string $region,
        ?string $requestId = null
    ) {
        parent::__construct($message, 421, $code, $requestId);
    }
}
