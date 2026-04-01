"""Division ordering and gap detection for meet data.

Division ordering is the agent's responsibility — the agent sees division
names (e.g. "5 yrs.", "Jr A", "18 & Up") and provides them in youngest-to-oldest
order via --division-order. This module handles:
  1. Building the {division: position} map from explicit or database order
  2. Detecting gaps in letter sequences (e.g. Ch A,B,C + Jr D → Jr A-C missing)
"""

import json
import os
import re
import sqlite3


def detect_division_order(db_path: str, meet_name: str,
                          explicit_order: list = None) -> tuple[dict, list[str]]:
    """Query DB for distinct divisions and return {name: sort_position} dict.

    Args:
        explicit_order: List of division names in youngest-to-oldest order,
            provided by the agent. When provided, these define the ordering.
            Divisions in the DB but not in the list are appended alphabetically.

    Returns:
        (order_dict, warnings) where order_dict maps division names to
        sort positions, and warnings lists any issues found.
    """
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute('SELECT DISTINCT division FROM results WHERE meet_name = ?',
                    (meet_name,))
        raw_divisions = [row[0] for row in cur.fetchall() if row[0]]

        # Also collect divisions from winners table
        winner_divisions = []
        try:
            cur.execute('SELECT DISTINCT division FROM winners WHERE meet_name = ?',
                        (meet_name,))
            winner_divisions = [row[0] for row in cur.fetchall() if row[0]]
        except sqlite3.OperationalError:
            pass  # winners table may not exist yet during initial build
    finally:
        conn.close()

    # ── Normalise case: merge divisions that differ only by case ────
    seen_upper: dict[str, str] = {}  # UPPER -> chosen canonical form
    for div in raw_divisions:
        key = div.strip().upper()
        if key not in seen_upper:
            seen_upper[key] = div
        else:
            existing = seen_upper[key]
            if div == key and existing != key:
                seen_upper[key] = div

    divisions = list(seen_upper.values())
    warnings = []

    if explicit_order:
        # Build ordering from the agent-provided list
        explicit_upper = {name.strip().upper(): i for i, name in enumerate(explicit_order)}

        # Separate known (in explicit list) from unknown (not in list)
        known = []
        unknown = []
        for div in divisions:
            if div.strip().upper() in explicit_upper:
                known.append(div)
            else:
                unknown.append(div)

        # Sort known by their explicit position, unknown alphabetically after
        known.sort(key=lambda d: explicit_upper[d.strip().upper()])
        unknown.sort()

        if unknown:
            warnings.append(
                f"UNORDERED_DIVISIONS: {', '.join(unknown)} — "
                f"not in the provided division order. Sorted alphabetically at the end."
            )

        scored = known + unknown
    else:
        # No explicit order provided — sort alphabetically and warn
        scored = sorted(divisions)
        if len(divisions) > 1:
            warnings.append(
                "NO_DIVISION_ORDER: No --division-order provided. Divisions are sorted "
                "alphabetically, which is likely WRONG. Use query_db to list divisions, "
                "then provide them in youngest-to-oldest order via the division_order parameter."
            )

    # Build position map
    order = {}
    pos = 1
    for div in scored:
        if div not in order:
            order[div] = pos
            pos += 1

    # Map non-canonical case variants to the same position
    canonical_pos = {d.strip().upper(): p for d, p in order.items()}
    for div in raw_divisions:
        if div not in order:
            key = div.strip().upper()
            if key in canonical_pos:
                order[div] = canonical_pos[key]

    for div in winner_divisions:
        if div not in order:
            key = div.strip().upper()
            if key in canonical_pos:
                order[div] = canonical_pos[key]
            else:
                # Division only in winners — append at end
                order[div] = pos
                pos += 1

    return order, warnings


def detect_division_gaps(divisions: list[str]) -> list[str]:
    """Detect obvious gaps in division letter sequences.

    Groups divisions by their tier/age prefix and checks for missing
    letters in the sequence. For example, if a level has Ch A, Ch B,
    Ch C, Jr D, Sr A-E, it flags "Jr A, Jr B, Jr C" as missing.

    Returns a list of human-readable gap descriptions.
    """
    # Classify each division into (group_key, letter) pairs
    groups: dict[str, list[str]] = {}  # group_key -> list of letters

    for div in divisions:
        upper = div.strip().upper()

        # Tier-based: "CH A", "JR B", "SR C", etc.
        tier_match = re.match(
            r'^(CHILD|CH|YOUTH|YTH|MIDDLE|MID|JUNIOR|JR|SENIOR|SR|YOUNGER|YOUNG|OLDER|OLD)'
            r'\.?\s+([A-Z])(?:\s*\d+)?$', upper)
        if tier_match:
            prefix = tier_match.group(1)
            prefix_map = {
                'CHILD': 'Ch', 'CH': 'Ch',
                'YOUTH': 'Yth', 'YTH': 'Yth',
                'JUNIOR': 'Jr', 'JR': 'Jr',
                'SENIOR': 'Sr', 'SR': 'Sr',
                'MIDDLE': 'Mid', 'MID': 'Mid',
                'YOUNGER': 'Younger', 'YOUNG': 'Younger',
                'OLDER': 'Older', 'OLD': 'Older',
            }
            key = prefix_map.get(prefix, prefix)
            letter = tier_match.group(2)
            groups.setdefault(key, []).append(letter)
            continue

        # Concatenated tier: "CHA", "JRB", "SRC1"
        concat_match = re.match(r'^(CH|JR|SR|YTH)([A-Z])(\d*)$', upper)
        if concat_match:
            prefix_map = {'CH': 'Ch', 'JR': 'Jr', 'SR': 'Sr', 'YTH': 'Yth'}
            key = prefix_map.get(concat_match.group(1), concat_match.group(1))
            letter = concat_match.group(2)
            groups.setdefault(key, []).append(letter)
            continue

        # Age-based with letter: "8A", "10 B", "12B"
        age_match = re.match(r'^(\d+)\s*([A-Z])$', upper)
        if age_match:
            key = f"Age {age_match.group(1)}"
            letter = age_match.group(2)
            groups.setdefault(key, []).append(letter)
            continue

    # Analyze each group for internal gaps
    warnings = []
    for key, letters in groups.items():
        unique = sorted(set(letters))
        if len(unique) < 2:
            continue

        first = ord(unique[0])
        last = ord(unique[-1])
        expected = set(chr(c) for c in range(first, last + 1))
        missing = sorted(expected - set(unique))

        if missing:
            missing_labels = [f"{key} {m}" for m in missing]
            warnings.append(
                f"DIVISION_GAP: {key} has {', '.join(unique)} but is missing "
                f"{', '.join(missing_labels)}"
            )

    # Cross-tier analysis: if sibling tiers (Ch/Jr/Sr) exist and one tier
    # starts at a high letter while others start at A, flag it as suspicious.
    tier_order = ['Ch', 'Yth', 'Jr', 'Sr']
    present_tiers = [t for t in tier_order if t in groups]
    if len(present_tiers) >= 2:
        starts_at_a = [t for t in present_tiers if 'A' in groups[t]]
        for tier in present_tiers:
            unique = sorted(set(groups[tier]))
            first_letter = unique[0]
            if first_letter > 'A' and len(starts_at_a) >= 1 and tier not in starts_at_a:
                missing_before = [f"{tier} {chr(c)}" for c in range(ord('A'), ord(first_letter))]
                warnings.append(
                    f"DIVISION_GAP: {tier} starts at {first_letter} (has {', '.join(unique)}) "
                    f"but sibling tiers start at A — possibly missing {', '.join(missing_before)}"
                )

    return warnings


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
    order, _warnings = detect_division_order(db_path, meet_name)

    # Save to cache
    all_orders[state] = order
    os.makedirs(config_dir, exist_ok=True)
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump(all_orders, f, indent=2)

    return order
