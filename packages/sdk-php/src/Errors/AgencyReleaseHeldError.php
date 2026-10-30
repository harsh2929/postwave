<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/** A structurally unavailable Agency capability; retrying cannot enable it. */
final class AgencyReleaseHeldError extends PostwaveError
{
    public readonly bool $retryable;
    public readonly bool $committed;

    public function __construct(string $message, string $code)
    {
        parent::__construct($message, 503, $code);
        $this->retryable = false;
        $this->committed = false;
    }
}
