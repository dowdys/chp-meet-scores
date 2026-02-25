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

    Pattern scoring:
        Child/CH*  -> 100 range
        Youth      -> 200 range
        Junior/JR* -> 300 range
        Senior/SR* -> 400 range
        Unknown    -> 500

    Sub-letter A-D adds 1-4. Bare full names without a letter
    (e.g. "Senior", "Child") get offset 5 (after lettered variants).
    Bare abbreviations without a letter (e.g. "SR") get offset 0
    (before lettered).
    """
    upper = name.strip().upper()

    # Try to extract a trailing letter (A-D)
    letter_match = re.search(r'[.\s]([A-D])$', upper)
    letter_offset = 0
    if letter_match:
        letter_offset = ord(letter_match.group(1)) - ord('A') + 1  # A=1, B=2, C=3, D=4

    # Determine the age group and base score
    # Child / CH patterns (100 range)
    if upper.startswith('CHILD') or re.match(r'^CH\b', upper):
        base = 100
    # Youth (200 range)
    elif upper.startswith('YOUTH'):
        base = 200
    # Junior / JR patterns (300 range)
    elif upper.startswith('JUNIOR') or re.match(r'^JR\.?\b', upper):
        base = 300
    # Senior / SR patterns (400 range)
    elif upper.startswith('SENIOR') or re.match(r'^SR\.?\b', upper):
        base = 400
    else:
        return 500  # Unknown

    # Bare full name (no letter) → offset 5 (after all lettered variants)
    # Bare abbreviation (no letter, e.g. "SR") → offset 0 (before lettered)
    if letter_offset == 0:
        if len(upper) > 3:
            # Full-name form like "CHILD", "JUNIOR", "SENIOR", "YOUTH"
            return base + 5
        else:
            # Short abbreviation like "SR", "CH", "JR"
            return base
    return base + letter_offset


def detect_division_order(db_path: str, meet_name: str) -> dict:
    """Query DB for distinct divisions and return {name: sort_position} dict.

    Sort positions are sequential integers starting from 1, assigned
    by the auto-detected scoring.
    """
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute('SELECT DISTINCT division FROM results WHERE meet_name = ?',
                (meet_name,))
    divisions = [row[0] for row in cur.fetchall() if row[0]]
    conn.close()

    # Score each division, then assign sequential positions
    scored = sorted(divisions, key=_score_division)
    order = {}
    pos = 1
    for div in scored:
        if div not in order:
            order[div] = pos
            pos += 1
    return order


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
    order = detect_division_order(db_path, meet_name)

    # Save to cache
    all_orders[state] = order
    os.makedirs(config_dir, exist_ok=True)
    with open(json_path, 'w') as f:
        json.dump(all_orders, f, indent=2)

    return order
