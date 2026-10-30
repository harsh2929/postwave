"""postwave — first-party Python SDK for the Moosewave API.

Quickstart::

    from postwave import Moosewave

    pw = Moosewave(api_key="sk_...", tenant_id="acme")
    page = pw.subscribers.list()

Async::

    from postwave import AsyncPostwave

    async with AsyncPostwave(api_key="sk_...") as pw:
        page = await pw.subscribers.list()
"""

from .client import AsyncPostwave, Moosewave
from .errors import (
    AgencyReleaseHeldError,
    AuthError,
    AmbiguousConversionIngestSecretIssueError,
    ConflictError,
    ForbiddenError,
    NetworkError,
    NotFoundError,
    ParseError,
    PostwaveError,
    RateLimitError,
    RequestAbortedError,
    ServerError,
    TimeoutError,
    ValidationError,
    WrongRegionError,
)
from .webhook import compute_signature_header, compute_signature_hex, verify_signature
from .resources.conversion_ingest import (
    AsyncConversionIngestResource,
    ConversionIngestResource,
    compute_conversion_email_hmac_sha256,
    compute_conversion_ingest_signature_header,
    compute_conversion_ingest_signature_hex,
)
from .resources.conversion_ingest_secrets import (
    AMBIGUOUS_ISSUE_RECOVERY,
    AsyncConversionIngestSecretsResource,
    ConversionIngestSecretsResource,
)
from .resources.campaign_polls import (
    AsyncCampaignPollsResource,
    CampaignPollsResource,
)
from .resources.sending_settings import SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS
from .resources.agency import (
    AGENCY_BILLING_MODE_RELEASE_HELD_CODE,
    AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE,
    AGENCY_CHILD_CREATE_RELEASE_HELD_CODE,
    AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE,
    AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE,
    AgencyBranding,
    AgencyChild,
    AgencyChildrenPage,
    decode_agency_branding,
    decode_agency_children_page,
)
from .resources.agent_mandates import (
    AgentMandateGrant,
    AgentMandateList,
    AgentMandateMinted,
    AgentMandateRevocation,
    AgentMandateSummary,
    AgentMandatesResource,
    AsyncAgentMandatesResource,
)
from .types import *  # noqa: F401,F403

__version__ = "0.1.0"

__all__ = [
    "Moosewave",
    "AsyncPostwave",
    "AgentMandatesResource",
    "AsyncAgentMandatesResource",
    "AgentMandateGrant",
    "AgentMandateList",
    "AgentMandateMinted",
    "AgentMandateRevocation",
    "AgentMandateSummary",
    "PostwaveError",
    "AgencyReleaseHeldError",
    "AmbiguousConversionIngestSecretIssueError",
    "AuthError",
    "ForbiddenError",
    "NotFoundError",
    "ConflictError",
    "ValidationError",
    "RateLimitError",
    "ServerError",
    "NetworkError",
    "TimeoutError",
    "RequestAbortedError",
    "ParseError",
    "WrongRegionError",
    "verify_signature",
    "compute_signature_hex",
    "compute_signature_header",
    "ConversionIngestResource",
    "AsyncConversionIngestResource",
    "ConversionIngestSecretsResource",
    "AsyncConversionIngestSecretsResource",
    "AMBIGUOUS_ISSUE_RECOVERY",
    "compute_conversion_email_hmac_sha256",
    "compute_conversion_ingest_signature_hex",
    "compute_conversion_ingest_signature_header",
    "CampaignPollsResource",
    "AsyncCampaignPollsResource",
    "SENDING_SETTINGS_RECONCILIATION_WAIT_SECONDS",
    "AGENCY_BILLING_MODE_RELEASE_HELD_CODE",
    "AGENCY_BRANDING_UPDATE_RELEASE_HELD_CODE",
    "AGENCY_CHILD_CREATE_RELEASE_HELD_CODE",
    "AGENCY_CHILD_UNLINK_RELEASE_HELD_CODE",
    "AGENCY_INVOICE_PREVIEW_RELEASE_HELD_CODE",
    "AgencyBranding",
    "AgencyChild",
    "AgencyChildrenPage",
    "decode_agency_branding",
    "decode_agency_children_page",
    "CampaignPollDefinition",
    "CampaignPollDefinitionOption",
    "CampaignPollList",
    "CampaignPollMaterializationInput",
    "CampaignPollOptionTally",
    "CampaignPollTally",
    "CampaignDirectAttributionEvidenceItem",
    "CampaignDirectAttributionEvidencePage",
    "CampaignDirectAttributionEvidencePageInfo",
    "CampaignDirectAttributionEvidenceSummary",
    "SignedConversionCredentials",
    "SignedConversionIdentity",
    "SignedConversionInput",
    "SignedConversionReceipt",
    "ConversionEmailHMACProjectionErrorCode",
    "ConversionEmailHMACProjectionStatus",
    "ConversionIngestSecretIssueResponse",
    "ConversionIngestSecretIssued",
    "ConversionIngestSecretPage",
    "ConversionIngestSecretRevoked",
    "ConversionIngestSecretSummary",
]
