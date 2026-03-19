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
        Younger/Young   -> 1000 range
        Child/CH*       -> 2000 range
        Youth/YTH*      -> 3000 range
        Middle          -> 4000 range
        Junior/JR*      -> 5000 range
        Senior/SR*      -> 6000 range
        Older/Old       -> 7000 range
        ALL             -> 9000 (catch-all, sorts last)

    Within each tier, group letters and sub-numbers produce offsets:
        base + group_letter * 10 + number
    e.g. JR A1 = 5010+1 = 5011, JR B2 = 5020+2 = 5022, SR A1 = 6011.

    Bare full names without a letter get offset 999 (after all lettered).
    Bare abbreviations without a letter get offset 0 (before lettered).

    Numeric divisions (1, 2, 3, etc.) get 50 + number, so they sort
    naturally before named groups.

    Single-letter divisions (A, B, C, D) get 10 + letter offset,
    treated as youngest-to-oldest alphabetically.

    Unknown patterns get 8000.
    """
    upper = name.strip().upper()
    if not upper:
        return 999

    # "ALL" — everyone competed together, sorts last
    if upper == 'ALL':
        return 9000

    # Pure numeric division (e.g. "1", "2", "3")
    if re.match(r'^\d+$', upper):
        return 50 + int(upper)

    # Single letter A-Z (e.g. "A", "B", "C", "D")
    if re.match(r'^[A-Z]$', upper):
        return 10 + (ord(upper) - ord('A') + 1)

    # ── Tier detection ──────────────────────────────────────────────
    # Map the tier prefix to its base score and figure out the remainder.
    tier_patterns = [
        (r'^(?:YOUNGER|YOUNG)\b',  1000),
        (r'^(?:CHILD|CH)\b',       2000),
        (r'^(?:YOUTH|YTH)\.?\b',   3000),
        (r'^(?:MIDDLE|MID)\b',     4000),
        (r'^(?:JUNIOR|JR)\.?\b',   5000),
        (r'^(?:SENIOR|SR)\.?\b',   6000),
        (r'^(?:OLDER|OLD)\b',      7000),
    ]

    base = None
    remainder = ''
    for pattern, score in tier_patterns:
        m = re.match(pattern, upper)
        if m:
            base = score
            remainder = upper[m.end():].strip(' .')
            break

    if base is None:
        return 8000  # Unknown — sorts after all known patterns

    # ── Parse the remainder after the tier prefix ───────────────────
    # Possible forms:
    #   ""       → bare tier ("JR", "JUNIOR")
    #   "A"      → group letter only ("JR A")
    #   "A1"     → group letter + sub-number ("JR A1")
    #   "A 1"    → group letter + space + sub-number ("JR A 1")

    # Compound: group letter + optional number (e.g. "A1", "B3", "C 2")
    compound = re.match(r'^([A-Z])\s*(\d+)$', remainder)
    if compound:
        group_offset = (ord(compound.group(1)) - ord('A') + 1) * 10
        number_offset = int(compound.group(2))
        return base + group_offset + number_offset

    # Simple group letter only (e.g. "A", "B", "C")
    # Uses same *10 scale as compounds so JR D (340) > JR C3 (333).
    # Sub-number 0 means the bare letter sorts before its numbered variants
    # (JR A=310 < JR A1=311).
    if re.match(r'^[A-Z]$', remainder):
        group_offset = (ord(remainder) - ord('A') + 1) * 10
        return base + group_offset

    # Bare tier — no group/number
    if remainder == '':
        # Short abbreviation like "SR", "CH", "JR" → offset 0 (before lettered)
        # Full-name form like "CHILD", "JUNIOR", "SENIOR" → offset 999 (after all lettered)
        if len(upper) > 3:
            return base + 999
        else:
            return base

    # Unrecognised remainder — still group under this tier but sort late
    return base + 9


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
        raw_divisions = [row[0] for row in cur.fetchall() if row[0]]
    finally:
        conn.close()

    # ── Normalise case: merge divisions that differ only by case ────
    # Keep one canonical form per uppercased key.  Prefer the ALL-CAPS
    # variant (e.g. "JR A" over "Jr A") for consistency; if none is
    # all-caps, keep the first one encountered.
    seen_upper: dict[str, str] = {}   # UPPER -> chosen canonical form
    for div in raw_divisions:
        key = div.strip().upper()
        if key not in seen_upper:
            seen_upper[key] = div
        else:
            # Prefer the version that is already fully uppercased
            existing = seen_upper[key]
            if div == key and existing != key:
                seen_upper[key] = div

    divisions = list(seen_upper.values())

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

    # Identify unknowns (score exactly 8000) for reporting
    unknowns = [d for d in divisions
                 if _score_division(d) == 8000 and d.strip().upper() not in explicit_map]

    scored = sorted(divisions, key=_sort_key)
    order = {}
    pos = 1
    for div in scored:
        if div not in order:
            order[div] = pos
            pos += 1

    # Also map the non-canonical case variants to the same position
    # so callers using either "Jr A" or "JR A" get the same result.
    canonical_pos = {d.strip().upper(): p for d, p in order.items()}
    for div in raw_divisions:
        if div not in order:
            key = div.strip().upper()
            if key in canonical_pos:
                order[div] = canonical_pos[key]

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
        with open(json_path, 'r', encoding='utf-8') as f:
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
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(all_orders, f, indent=2)

    return order
