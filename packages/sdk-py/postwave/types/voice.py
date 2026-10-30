from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore")


VoiceSourceType = Literal["rss", "sitemap", "substack", "beehiiv", "manual_paste", "file_upload"]
TemplateCategory = Literal[
    "welcome", "course_launch", "product_launch", "re_engagement",
    "newsletter_series", "saas_onboarding", "partnership", "year_in_review",
    "crisis", "cold_warm", "sales", "community", "misc",
]


class Stylistic(_Base):
    avg_sentence_length: float = 0.0
    sentence_length_variance: float = 0.0
    avg_paragraph_length: float = 0.0
    formality_score: float = 0.0
    hedging_frequency: float = 0.0
    passive_voice_pct: float = 0.0


class TermWeight(_Base):
    term: str
    score: float


class PhraseFreq(_Base):
    phrase: str
    n: int = 2
    count: int = 0


class Vocabulary(_Base):
    distinctive_terms: list[TermWeight] = Field(default_factory=list)
    recurring_phrases: list[PhraseFreq] = Field(default_factory=list)
    idiom_markers: list[str] = Field(default_factory=list)
    metaphor_patterns: list[str] = Field(default_factory=list)


class Structural(_Base):
    opening_hook_style: str = ""
    closing_pattern: str = ""
    bullet_list_usage_rate: float = 0.0
    markdown_style_hint: str = ""


class Tonal(_Base):
    humor: float = 0.0
    optimism: float = 0.0
    personal_vs_observational: float = 0.0
    directness: float = 0.0


class Persona(_Base):
    pronoun_usage: dict[str, float] = Field(default_factory=dict)
    self_disclosure_rate: float = 0.0
    recurring_themes: list[str] = Field(default_factory=list)


class Sample(_Base):
    text: str
    source: str | None = None
    url: str | None = None


class SourceStat(_Base):
    word_count: int = 0
    item_count: int = 0
    last_ingested_at: datetime | None = None


class VoiceProfile(_Base):
    tenant_id: str
    version: int = 1
    generated_at: datetime | None = None
    stylistic: Stylistic = Field(default_factory=Stylistic)
    vocabulary: Vocabulary = Field(default_factory=Vocabulary)
    structural: Structural = Field(default_factory=Structural)
    tonal: Tonal = Field(default_factory=Tonal)
    persona: Persona = Field(default_factory=Persona)
    representative_samples: list[Sample] = Field(default_factory=list)
    source_summary: dict[str, SourceStat] = Field(default_factory=dict)


class VoiceSource(_Base):
    id: str
    tenant_id: str = ""
    type: VoiceSourceType
    params: dict[str, Any] = Field(default_factory=dict)
    last_ingested_at: datetime | None = None
    last_item_count: int = 0


class RegisterVoiceSource(_Base):
    type: VoiceSourceType
    params: dict[str, Any] = Field(default_factory=dict)


class StyleControls(_Base):
    humor: float = 0.0
    directness: float = 0.0
    formality_shift: float = 0.0
    length: Literal["", "shorter", "longer", "as-is"] = ""


class GeneratedEmail(_Base):
    position: int
    delay_seconds: int = 0
    subject: str
    body: str
    body_html: str | None = None
    voice_fidelity_score: float = 0.0
    regeneration_count: int = 0


SequenceStepType = Literal["email", "delay", "condition", "tag_add", "tag_remove", "exit"]


class SequenceEmailStep(_Base):
    subject: str
    body: str
    body_html: str | None = None
    delay_seconds: int = 0
    template_id: str = ""


class SequenceDelayStep(_Base):
    seconds: int
    value: int = 0
    unit: Literal["", "minutes", "hours", "days"] = ""


class SequenceTagStep(_Base):
    tag: str


class SequenceConditionStep(_Base):
    predicate: str
    value: str = ""
    yes_branch: list["SequenceStep"] = Field(default_factory=list)
    no_branch: list["SequenceStep"] = Field(default_factory=list)


class SequenceStep(_Base):
    type: SequenceStepType
    position: int
    email: SequenceEmailStep | None = None
    delay: SequenceDelayStep | None = None
    condition: SequenceConditionStep | None = None
    tag: SequenceTagStep | None = None


class Sequence(_Base):
    id: str
    tenant_id: str
    template_id: str
    name: str
    status: Literal["draft", "active", "archived"] = "draft"
    version: int = Field(ge=1)
    emails: list[GeneratedEmail] = Field(default_factory=list)
    steps: list[SequenceStep] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    low_fidelity_flag: bool = False


class GenerateRequest(_Base):
    template_id: str
    name: str
    variables: dict[str, str] = Field(default_factory=dict)
    style_controls: StyleControls = Field(default_factory=StyleControls)
    profile: VoiceProfile | None = None


class RegenerateRequest(_Base):
    style_controls: StyleControls = Field(default_factory=StyleControls)
    user_hint: str | None = None
    variables: dict[str, str] = Field(default_factory=dict)


class TemplateVariable(_Base):
    key: str
    label: str
    required: bool = False
    example: str = ""


class TemplateEmail(_Base):
    position: int
    delay_seconds: int = 0
    subject_skeleton: str
    body_skeleton: str
    notes: str = ""


class TemplatePerformance(_Base):
    open_rate: float = 0.0
    click_rate: float = 0.0
    conversion_rate: float = 0.0
    sample_size: int = 0


class Template(_Base):
    id: str
    slug: str
    category: TemplateCategory
    name: str
    description: str = ""
    length: int = 0
    variables: list[TemplateVariable] = Field(default_factory=list)
    emails: list[TemplateEmail] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    author: str = ""
    performance: TemplatePerformance = Field(default_factory=TemplatePerformance)
    created_at: datetime | None = None
    updated_at: datetime | None = None
