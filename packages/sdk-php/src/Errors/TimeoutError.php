<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/** The request did not complete within the configured timeout. */
class TimeoutError extends NetworkError
{
    public function __construct(string $message = 'Request timed out')
    {
        parent::__construct($message, 'request_timeout');
    }
}
