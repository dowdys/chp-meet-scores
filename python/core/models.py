"""Data models for the gymnastics meet scoring system."""

from dataclasses import dataclass, field


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
