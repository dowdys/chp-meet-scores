"""Shared constants for the gymnastics meet scoring system."""
from __future__ import annotations

# Event keys used across all modules (vault, bars, beam, floor, all-around)
EVENTS = ['vault', 'bars', 'beam', 'floor', 'aa']

# Display names for events
EVENT_DISPLAY = {
    'vault': 'Vault', 'bars': 'Bars', 'beam': 'Beam',
    'floor': 'Floor', 'aa': 'All Around',
}

# Short display names (AA instead of All Around)
EVENT_DISPLAY_SHORT = {
    'vault': 'Vault', 'bars': 'Bars', 'beam': 'Beam',
    'floor': 'Floor', 'aa': 'AA',
}

# Column headers for PDF shirt back (uppercase)
EVENT_HEADERS = ['VAULT', 'BARS', 'BEAM', 'FLOOR', 'ALL AROUND']

# Xcel level ordering (Bronze → Sapphire)
XCEL_ORDER = {
    'XB': 0, 'XS': 1, 'XG': 2, 'XP': 3, 'XD': 4, 'XSA': 5,
    'BRONZE': 0, 'SILVER': 1, 'GOLD': 2, 'PLATINUM': 3, 'DIAMOND': 4, 'SAPPHIRE': 5,
}

# --- Page layout constants ---
PAGE_W = 612
PAGE_H = 792           # Letter: 8.5 x 11
PAGE_H_LEGAL = 1008    # Legal:  8.5 x 14

# Column center X positions for 5-column layout
COL_CENTERS = [72, 192, 306, 420, 546]

# Colors (RGB 0-1 tuples)
RED = (1, 0, 0)
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)
YELLOW_HL = (1.0, 1.0, 0.0)

# Default text content
DEFAULT_SPORT = 'GYMNASTICS'
DEFAULT_TITLE_PREFIX = 'STATE CHAMPIONS OF'
DEFAULT_COPYRIGHT = '\u00a9 C. H. Publishing'

# Fonts
FONT_REGULAR = 'Times-Roman'
FONT_BOLD = 'Times-Bold'

# Font sizes
TITLE1_LARGE = 18
TITLE1_SMALL = 14
TITLE2_LARGE = 20
TITLE2_SMALL = 15
HEADER_LARGE = 11
HEADER_SMALL = 8
DEFAULT_NAME_SIZE = 9
MIN_NAME_SIZE = 6.5
LEVEL_DIVIDER_SIZE = 10
COPYRIGHT_SIZE = 7
OVAL_LABEL_SIZE = 12

# Layout Y positions (derived from page height and default title sizes)
COPYRIGHT_Y = PAGE_H - 8
NAMES_BOTTOM_Y = PAGE_H - 18
# Default NAMES_START_Y computed from compute_layout(TITLE1_LARGE, TITLE2_LARGE)
NAMES_START_Y = 121

# Tight spacing: 1.15 ratio keeps names close together, maximizing font size
LINE_HEIGHT_RATIO = 1.15
LEVEL_GAP = 6

# Target page fill: don't fill more than 90% of available space
MAX_PAGE_FILL = 0.90

# Xcel level mapping (abbreviation and full-name forms)
XCEL_MAP = {
    'XSA': 'SAPPHIRE', 'XD': 'DIAMOND', 'XP': 'PLATINUM',
    'XG': 'GOLD', 'XS': 'SILVER', 'XB': 'BRONZE',
    'Sapphire': 'SAPPHIRE', 'Diamond': 'DIAMOND', 'Platinum': 'PLATINUM',
    'Gold': 'GOLD', 'Silver': 'SILVER', 'Bronze': 'BRONZE',
    'SAPPHIRE': 'SAPPHIRE', 'DIAMOND': 'DIAMOND', 'PLATINUM': 'PLATINUM',
    'GOLD': 'GOLD', 'SILVER': 'SILVER', 'BRONZE': 'BRONZE',
}
# Prestige order (highest first)
XCEL_PRESTIGE_ORDER = ['SAPPHIRE', 'DIAMOND', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE']


# US state name → abbreviation (for auto-deriving state_abbrev from state name)
STATE_ABBREVS = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN',
    'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE',
    'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
    'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR',
    'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA',
    'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
}


def state_to_abbrev(state: str) -> str:
    """Convert a state name to its 2-letter abbreviation.

    If already an abbreviation (2 uppercase letters), returns as-is.
    Returns original string if no match found.
    """
    if not state:
        return state
    # Already an abbreviation
    if len(state) <= 3 and state == state.upper():
        return state
    # Handle variants like "CA - NorCal"
    abbrev = STATE_ABBREVS.get(state.lower())
    if abbrev:
        return abbrev
    return state


def sort_levels(levels: list[str]) -> list[str]:
    """Sort levels: numbered ascending, then Xcel in program order.

    Args:
        levels: List of level strings (e.g. ['3', '4', 'XB', 'XG', '10'])

    Returns:
        Sorted list with numbered levels first, then Xcel.
    """
    numbered = sorted([l for l in levels if l.isdigit()], key=int)
    xcel = sorted(
        [l for l in levels if not l.isdigit()],
        key=lambda x: XCEL_ORDER.get(x.upper(), 99)
    )
    return numbered + xcel
