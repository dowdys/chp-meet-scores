"""Auto-detect division ordering from meet data.

Scores each division name by pattern to produce a natural age-based
sort order (Child < Youth < Junior < Senior), with sub-letters A-D
ordering within each group.
"""

import json
import os
import re
import sqlite3


def _score_division(name: str) -> int:
    """Assign a numeric sort score to a division name.

    Age-group pattern scoring (youngest → oldest):
        Younger/Young   -> 100 range
        Child/CH*       -> 150 range
        Youth/YTH*      -> 200 range
        Middle          -> 250 range
        Junior/JR*      -> 300 range
        Senior/SR*      -> 400 range
        Older/Old       -> 450 range
        ALL             -> 900 (catch-all, sorts last)

    Sub-letter A-D adds 1-4 within each group (e.g. "Child A" = 151).
    Bare full names without a letter get offset 5 (after lettered).
    Bare abbreviations without a letter get offset 0 (before lettered).

    Numeric divisions (1, 2, 3, etc.) get 50 + number, so they sort
    naturally before named groups.

    Single-letter divisions (A, B, C, D) get 10 + letter offset,
    treated as youngest-to-oldest alphabetically.

    Unknown patterns get 500.
    """
    upper = name.strip().upper()
    if not upper:
        return 999

    # "ALL" — everyone competed together, sorts last
    if upper == 'ALL':
        return 900

    # Pure numeric division (e.g. "1", "2", "3")
    if re.match(r'^\d+$', upper):
        return 50 + int(upper)

    # Single letter A-Z (e.g. "A", "B", "C", "D")
    if re.match(r'^[A-Z]$', upper):
        return 10 + (ord(upper) - ord('A') + 1)

    # Try to extract a trailing letter (A-E)
    letter_match = re.search(r'[.\s]([A-E])$', upper)
    letter_offset = 0
    if letter_match:
        letter_offset = ord(letter_match.group(1)) - ord('A') + 1  # A=1, B=2, ...

    # Determine the age group and base score
    # Younger / Young (100 range — youngest named group)
    if upper.startswith('YOUNGER') or upper == 'YOUNG':
        base = 100
    # Child / CH patterns (150 range)
    elif upper.startswith('CHILD') or re.match(r'^CH\b', upper) or re.match(r'^CHA?$', upper):
        base = 150
    # Youth / YTH patterns (200 range)
    elif upper.startswith('YOUTH') or re.match(r'^YTH\.?\b', upper):
        base = 200
    # Middle (250 range)
    elif upper.startswith('MIDDLE') or upper == 'MID':
        base = 250
    # Junior / JR patterns (300 range)
    elif upper.startswith('JUNIOR') or re.match(r'^JR\.?\b', upper):
        base = 300
    # Senior / SR patterns (400 range)
    elif upper.startswith('SENIOR') or re.match(r'^SR\.?\b', upper):
        base = 400
    # Older / Old (450 range — oldest named group)
    elif upper.startswith('OLDER') or upper == 'OLD':
        base = 450
    else:
        return 500  # Unknown — sorts after all known patterns

    # Bare full name (no letter) → offset 5 (after all lettered variants)
    # Bare abbreviation (no letter, e.g. "SR") → offset 0 (before lettered)
    if letter_offset == 0:
        if len(upper) > 3:
            # Full-name form like "CHILD", "JUNIOR", "SENIOR", "YOUNGER"
            return base + 5
        else:
            # Short abbreviation like "SR", "CH", "JR"
            return base
    return base + letter_offset


def detect_division_order(db_path: str, meet_name: str,
                          explicit_order: list = None) -> dict:
    """Query DB for distinct divisions and return {name: sort_position} dict.

    Args:
        explicit_order: Optional list of division names in youngest-to-oldest
            order. When provided, these override auto-scoring for any matching
            divisions. Unmatched divisions still use auto-scoring.

    Sort positions are sequential integers starting from 1, assigned
    by the auto-detected scoring (or explicit ordering when provided).
    """
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute('SELECT DISTINCT division FROM results WHERE meet_name = ?',
                    (meet_name,))
        divisions = [row[0] for row in cur.fetchall() if row[0]]
    finally:
        conn.close()

    # Build explicit ordering map (case-insensitive matching)
    explicit_map = {}
    if explicit_order:
        for i, name in enumerate(explicit_order):
            explicit_map[name.strip().upper()] = i

    def _sort_key(div):
        upper = div.strip().upper()
        if upper in explicit_map:
            return explicit_map[upper]
        return _score_division(div)

    # Identify unknowns (score exactly 500) for reporting
    unknowns = [d for d in divisions
                 if _score_division(d) == 500 and d.strip().upper() not in explicit_map]

    scored = sorted(divisions, key=_sort_key)
    order = {}
    pos = 1
    for div in scored:
        if div not in order:
            order[div] = pos
            pos += 1
    return order, unknowns


def get_division_order(db_path: str, meet_name: str, state: str,
                       config_dir: str) -> dict:
    """Load division order from JSON cache, or detect + save.

    JSON file: {config_dir}/state_divisions.json
    Structure: {"Iowa": {"CH A": 1, ...}, "Utah": {...}}
    """
    json_path = os.path.join(config_dir, 'state_divisions.json')

    # Try loading from cache
    if os.path.exists(json_path):
        with open(json_path, 'r') as f:
            all_orders = json.load(f)
        if state in all_orders:
            return all_orders[state]
    else:
        all_orders = {}

    # Detect from data
    order, _unknowns = detect_division_order(db_path, meet_name)

    # Save to cache
    all_orders[state] = order
    os.makedirs(config_dir, exist_ok=True)
    with open(json_path, 'w') as f:
        json.dump(all_orders, f, indent=2)

    return order
