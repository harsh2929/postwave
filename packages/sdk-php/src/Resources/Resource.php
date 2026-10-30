<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Resources;

use Moosewave\Client;

/**
 * Resource is the base for every endpoint wrapper. Holds the Client
 * reference so subclasses can call $this->client->request(...).
 */
abstract class Resource
{
    public function __construct(protected Client $client)
    {
    }
}
