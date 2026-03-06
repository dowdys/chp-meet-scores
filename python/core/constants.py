"""Shared constants for the gymnastics meet scoring system."""

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
