"""Data models for the gymnastics meet scoring system."""

from dataclasses import dataclass, field, asdict
from typing import ClassVar


@dataclass
class LayoutParams:
    """Appearance-only parameters for shirt layout.

    CRITICAL: Destructive filters (exclude_levels, level_groups, page_size)
    must NEVER be included here. See docs/solutions/logic-errors/
    sticky-params-silently-exclude-athletes.md
    """
    # Spacing
    line_spacing: float | None = None
    level_gap: float | None = None
    max_fill: float | None = None

    # Font sizes
    min_font_size: float | None = None
    max_font_size: float | None = None
    title1_size: float | None = None
    title2_size: float | None = None
    header_size: float | None = None
    divider_size: float | None = None

    # Content
    sport: str | None = None
    title_prefix: str | None = None
    copyright: str | None = None
    accent_color: str | None = None
    font_family: str | None = None

    # Layout constraints
    max_shirt_pages: int | None = None
    name_sort: str = 'age'

    # Structural enforcement: only these fields are persisted
    STICKY_FIELDS: ClassVar[frozenset] = frozenset({
        'line_spacing', 'level_gap', 'max_fill', 'min_font_size', 'max_font_size',
        'max_shirt_pages', 'title1_size', 'title2_size', 'header_size', 'divider_size',
        'sport', 'title_prefix', 'copyright', 'accent_color', 'font_family',
    })

    def to_sticky_dict(self) -> dict:
        """Only serialize appearance params. NEVER destructive filters."""
        return {k: v for k, v in asdict(self).items()
                if k in self.STICKY_FIELDS and v is not None}

    @classmethod
    def from_sticky_dict(cls, d: dict) -> 'LayoutParams':
        """Load only recognized sticky fields, ignoring anything else."""
        return cls(**{k: v for k, v in d.items() if k in cls.STICKY_FIELDS})


@dataclass
class MeetConfig:
    """Configuration for a single gymnastics meet."""
    state: str                # "Iowa", "Utah", "Colorado", "Alabama"
    meet_name: str            # "2025 Iowa Dev State Championships"
    association: str          # "USAG" or "AAU"
    source_type: str          # "scorecat", "mso_pdf", "mso_html"
    title_lines: tuple = ()   # ("2025 Gymnastics", "State Champions of Iowa", "Levels 2-10")
    division_order: dict = field(default_factory=dict)  # Division age ordering for CSV sort
    year: str = ''            # Championship year (e.g. "2026") for PDF titles
