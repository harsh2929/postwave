<?php
// SPDX-License-Identifier: MIT
declare(strict_types=1);

namespace Moosewave\Errors;

/** The request was aborted before a response was received. */
class RequestAbortedError extends NetworkError
{
    public function __construct(string $message = 'Request aborted')
    {
        parent::__construct($message, 'request_aborted');
    }
}
