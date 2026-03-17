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
