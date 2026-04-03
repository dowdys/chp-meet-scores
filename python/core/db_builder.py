"""Unified database builder for gymnastics meet results.

Winner determination is always score-based (max score per session+level+division+event).
This ensures ties are properly detected regardless of data source — some sources
(e.g. ScoreCat) may assign sequential ranks to tied athletes instead of giving
both rank 1.
"""
from __future__ import annotations

import json
import re
import sqlite3
import os
from .models import MeetConfig
from .constants import EVENTS


# --- Unified athlete name cleanup ---
# Handles ALL known event code formats from every data source:
#   ScoreCat:  "Addie Wolff **V/BB/FX", "Kelly*(V,BB,FX)", "Holder- BB, FX"
#   MSO:       "Jane Smith VT,BB,FX", "Name IES VT,BB", "Raygan Jones  BB"
#   Attached:  "PrevendarVT,BB,FX" (no space before codes)
#   Trailing:  "Bella Estrada VT,", "Name V/"
# Applied once at database build time. Downstream functions can trust names are clean.

# Event codes used in women's gymnastics (case-insensitive matching).
# Note: single-char codes V/Be/Fl risk false positives on names ending
# with initials (pre-existing limitation).
_EC = r'(?:VT|UB|BB|FX|Bars?|Beam|BM|Floor|V|Be|Fl|Fx|AA)'
_EC_SEQ = _EC + r'(?:[/,\s]+' + _EC + r')*'  # sequence with any separator

# Ordered from most specific to least specific to avoid false positives
_CLEANUP_PATTERNS = [
    # 1. Parenthetical with optional * prefix: "Kelly*(V,BB,FX)", "Name (VT)"
    re.compile(r'\s*\*{0,2}\s*\([^)]*\)\s*$', re.IGNORECASE),
    # 2. ** or * followed by event codes: "Name **V/BB/FX", "Name ** BB, FX"
    re.compile(r'\s*\*{1,2}\s*(?:IES\s+)?' + _EC_SEQ + r'[/,\s]*$', re.IGNORECASE),
    # 3. Remaining lone ** or *: "Name **"
    re.compile(r'\s*\*{1,2}\s*$'),
    # 4. Dash-prefixed codes: "Holder- BB, FX", "Name - VT, FX"
    re.compile(r'\s*-\s*' + _EC_SEQ + r'[,/\s]*$', re.IGNORECASE),
    # 5. IES prefix + codes: "Name IES VT,BB"
    re.compile(r'\s+IES\s+' + _EC_SEQ + r'[,/\s]*$', re.IGNORECASE),
    # 6. Space-separated codes at end: "Name VT,BB,FX", "Name VT BB", "Name VT,"
    re.compile(r'\s+' + _EC_SEQ + r'[,/\s]*$', re.IGNORECASE),
    # 7. Attached codes (no space): "PrevendarVT,BB,FX"
    #    Detects lowercase→uppercase boundary before an UPPERCASE event code.
    #    Case-sensitive: prevents matching "bb" in names like "Webb" or "Robb".
    re.compile(r'(?<=[a-z])(?:VT|UB|BB|FX|AA)(?:[,/\s]+' + _EC + r')*[,/\s]*$'),
]


def clean_athlete_name(name: str) -> str:
    """Strip event code suffixes from athlete names.

    Canonical cleanup function — handles all known formats from every data source.
    Applied during database building so all downstream code can trust names are clean.
    Patterns are ordered most-specific-first to minimize false positives.
    """
    if not name:
        return name
    result = name
    for pattern in _CLEANUP_PATTERNS:
        cleaned = pattern.sub('', result)
        if cleaned != result:
            result = cleaned.strip()
            break  # Stop after first match to avoid over-cleaning
    return result


def build_database(db_path: str, config: MeetConfig, athletes: list[dict]) -> str:
    """Build a SQLite database from parsed athlete data.

    Uses a central database model: creates tables if they don't exist,
    deletes existing data for this specific meet, then inserts fresh data.
    This allows multiple meets to coexist in one database.

    Args:
        db_path: Path for the output SQLite database.
        config: MeetConfig with state, meet_name, association, source_type.
        athletes: List of athlete dicts from an adapter.

    Returns:
        The db_path for convenience.
    """
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()

        # --- DDL (must be outside the data transaction) ---
        cur.execute('''CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state TEXT,
            meet_name TEXT,
            association TEXT,
            name TEXT,
            gym TEXT,
            club_num TEXT,
            session TEXT,
            level TEXT,
            division TEXT,
            vault REAL,
            bars REAL,
            beam REAL,
            floor REAL,
            aa REAL,
            rank TEXT,
            num TEXT
        )''')

        try:
            cur.execute('ALTER TABLE results ADD COLUMN club_num TEXT')
        except Exception:
            pass  # Column already exists

        cur.execute('''CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique
            ON results(meet_name, name, gym, session, level, division)''')
        cur.execute('CREATE INDEX IF NOT EXISTS idx_results_meet_sld ON results(meet_name, session, level, division)')

        cur.execute('''CREATE TABLE IF NOT EXISTS meets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meet_name TEXT UNIQUE,
            source TEXT,
            source_id TEXT,
            source_name TEXT,
            state TEXT,
            association TEXT,
            year TEXT,
            dates TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )''')
        conn.commit()

        # --- Data operations: explicit atomic transaction ---
        # All data changes (DELETE + INSERT + normalize + winners) commit together.
        # If any step fails, the staging DB rolls back (no partial state).
        cur.execute('BEGIN IMMEDIATE')
        try:
            # Clean slate: delete ALL data in staging DB (single-meet by design)
            cur.execute('DELETE FROM results')
            for table in ('winners', 'meets'):
                try:
                    cur.execute(f'DELETE FROM {table}')
                except Exception:
                    pass  # Table doesn't exist yet

            names_cleaned = 0
            for a in athletes:
                raw_name = a['name']
                cleaned_name = clean_athlete_name(raw_name)
                if cleaned_name != raw_name:
                    names_cleaned += 1
                cur.execute('''INSERT OR REPLACE INTO results
                    (state, meet_name, association, name, gym, club_num, session, level, division,
                     vault, bars, beam, floor, aa, rank, num)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (config.state, config.meet_name, config.association,
                     cleaned_name, a['gym'], a.get('club_num', ''),
                     a['session'], a['level'], a['division'],
                     a['vault'], a['bars'], a['beam'], a['floor'], a['aa'],
                     a.get('rank'), a.get('num')))
            if names_cleaned > 0:
                print(f"Name cleaning: stripped event code suffixes from {names_cleaned} athlete names")

            # Normalize division case (part of the same transaction)
            _normalize_division_case(cur, config.meet_name)

            # Always use score-based winner determination — ranks from data sources
            # may not handle ties correctly (e.g. ScoreCat assigns sequential ranks
            # to tied athletes instead of giving both rank 1)
            _build_winners_score_based(conn, config)

            conn.commit()
        except Exception:
            conn.rollback()
            raise
    finally:
        conn.close()
    return db_path


def _normalize_division_case(cur, meet_name: str):
    """Merge division variants that differ only by case (e.g., JR A / Jr A / JRA).

    When combining data from multiple sources (MSO + ScoreCat), the same division
    may appear with different casing. This picks a canonical form for each group
    and updates all records to match.
    """
    cur.execute('SELECT DISTINCT division FROM results WHERE meet_name = ?', (meet_name,))
    all_divs = [r[0] for r in cur.fetchall() if r[0]]

    # Group by uppercased key with spaces stripped
    groups = {}  # UPPER_NO_SPACES -> [original forms]
    for div in all_divs:
        key = div.strip().upper().replace(' ', '')
        groups.setdefault(key, []).append(div)

    merged = 0
    for key, variants in groups.items():
        if len(variants) <= 1:
            continue
        # Pick canonical: prefer version with spaces ("Jr A" over "JRA"),
        # then prefer mixed case over ALL CAPS
        canonical = sorted(variants, key=lambda v: (-len(v), v == v.upper(), v))[0]
        for variant in variants:
            if variant != canonical:
                cur.execute('UPDATE results SET division = ? WHERE meet_name = ? AND division = ?',
                            (canonical, meet_name, variant))
                count = cur.rowcount
                if count > 0:
                    merged += count
                    print(f"  Division merged: \"{variant}\" -> \"{canonical}\" ({count} rows)")

    if merged:
        print(f"  Total division merges: {merged} rows")


def _create_winners_table(cur, meet_name: str):
    """Create the winners table if needed and clear data for this meet."""
    cur.execute('''CREATE TABLE IF NOT EXISTS winners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT,
        meet_name TEXT,
        association TEXT,
        name TEXT,
        gym TEXT,
        session TEXT,
        level TEXT,
        division TEXT,
        event TEXT,
        score REAL,
        is_tie INTEGER DEFAULT 0
    )''')
    cur.execute('''CREATE UNIQUE INDEX IF NOT EXISTS idx_winners_unique
        ON winners(meet_name, name, gym, session, level, division, event)''')
    # Covering indexes for common query patterns (output generation, gym lookups)
    cur.execute('CREATE INDEX IF NOT EXISTS idx_winners_meet_event_level ON winners(meet_name, event, level)')
    cur.execute('CREATE INDEX IF NOT EXISTS idx_winners_meet_gym ON winners(meet_name, gym)')
    # Winners are always fully rebuilt per meet
    cur.execute('DELETE FROM winners WHERE meet_name = ?', (meet_name,))


def _find_solo_sessions(cur, meet_name: str) -> set:
    """Find "out of session" competitors — solo athletes who are accommodation cases.

    An athlete competing alone in a session is only excluded if the same level+division
    has multiple athletes in a DIFFERENT session. This distinguishes:
    - Out-of-session accommodation (e.g., Sunday religious observance): the same
      level+division exists in another session with real competition → exclude
    - Legitimately the only athlete in that division at the meet: no other session
      has that level+division with multiple athletes → keep as champion

    Returns a set of (session, level, division) tuples to exclude.
    """
    # Step 1: Find all solo groups (session+level+division with exactly 1 athlete)
    cur.execute('''SELECT session, level, division
                   FROM results WHERE meet_name = ?
                   GROUP BY session, level, division
                   HAVING COUNT(DISTINCT name) = 1''', (meet_name,))
    solo_groups = [(row[0], row[1], row[2]) for row in cur.fetchall()]

    if not solo_groups:
        return set()

    # Step 2: Find level+division combos that have real competition (2+ athletes)
    # in at least one session
    cur.execute('''SELECT level, division
                   FROM results WHERE meet_name = ?
                   GROUP BY session, level, division
                   HAVING COUNT(DISTINCT name) >= 2''', (meet_name,))
    has_competition = {(row[0], row[1]) for row in cur.fetchall()}

    # Step 3: Only exclude solo groups whose level+division has competition elsewhere
    excluded = set()
    for session, level, division in solo_groups:
        if (level, division) in has_competition:
            excluded.add((session, level, division))

    # Report both excluded and kept solo athletes
    kept_solos = [(s, l, d) for s, l, d in solo_groups if (s, l, d) not in excluded]
    if excluded:
        print(f"  Solo sessions: {len(excluded)} out-of-session group(s) excluded")
    if kept_solos:
        print(f"  WARNING: {len(kept_solos)} athlete(s) competing alone at their level/division "
              f"(no other athletes in that division at the entire meet):")
        solo_kept_list = []
        for s, l, d in kept_solos:
            cur.execute('SELECT name, gym FROM results WHERE meet_name = ? AND session = ? AND level = ? AND division = ?',
                        (meet_name, s, l, d))
            row = cur.fetchone()
            if row:
                print(f"    {row[0]} ({row[1]}) -- S{s} L{l} Div {d}")
                solo_kept_list.append({"name": row[0], "gym": row[1], "level": l, "division": d, "session": s})
        print(f"  These athletes won all events by default. Verify with user if they should be on the shirt.")
        if solo_kept_list:
            print(f"SOLO_WINNERS_JSON: {json.dumps(solo_kept_list)}")
    return excluded


def _build_winners_score_based(conn: sqlite3.Connection, config: MeetConfig):
    """Determine winners by max score per session+level+division+event.

    Used for MSO PDF and MSO HTML sources.
    """
    cur = conn.cursor()
    _create_winners_table(cur, config.meet_name)

    # Find solo sessions (only 1 athlete in that session+level+division).
    # These are "out of session" competitors (e.g., Sunday religious accommodation)
    # who are NOT eligible for state champion status.
    solo_sessions = _find_solo_sessions(cur, config.meet_name)

    # Use COALESCE in queries (not UPDATE) to handle NULLs without mutating source data
    cur.execute('''SELECT DISTINCT COALESCE(session,'') as session,
                   COALESCE(level,'') as level,
                   COALESCE(division,'') as division
                   FROM results WHERE meet_name = ?
                   ORDER BY level, division, session''', (config.meet_name,))
    combos = cur.fetchall()

    insert_errors = 0
    for session, level, division in combos:
        if (session, level, division) in solo_sessions:
            continue
        for event in EVENTS:
            # Find max score (exclude NULLs and zeroes)
            cur.execute(f'''SELECT MAX({event}) FROM results
                           WHERE meet_name = ? AND session = ? AND level = ? AND division = ?
                             AND {event} IS NOT NULL AND {event} > 0''',
                        (config.meet_name, session, level, division))
            max_score = cur.fetchone()[0]
            if max_score is None:
                continue

            # Find all athletes with that max score
            cur.execute(f'''SELECT name, gym FROM results
                           WHERE meet_name = ? AND session = ? AND level = ? AND division = ?
                             AND {event} = ?''',
                        (config.meet_name, session, level, division, max_score))
            winners = cur.fetchall()

            is_tie = 1 if len(winners) > 1 else 0
            for name, gym in winners:
                try:
                    cur.execute('''INSERT OR REPLACE INTO winners
                        (state, meet_name, association, name, gym, session, level, division,
                         event, score, is_tie)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                        (config.state, config.meet_name, config.association,
                         name, gym or '', session, level, division, event, max_score, is_tie))
                except Exception as e:
                    insert_errors += 1
                    if insert_errors <= 5:  # log first 5 errors to avoid flooding
                        print(f"  Warning: Failed to insert winner: name={name!r} gym={gym!r} "
                              f"session={session!r} level={level!r} division={division!r} "
                              f"event={event} score={max_score}: {e}")

    if insert_errors:
        print(f"  Warning: {insert_errors} winner insert(s) failed (see above)")
        print(f"WINNER_INSERT_ERRORS: {insert_errors} total insert failures")

    # Level cross-check: every level in results should have at least one winner
    cur.execute('SELECT DISTINCT level FROM results WHERE meet_name = ?', (config.meet_name,))
    levels_in_results = {row[0] for row in cur.fetchall()}
    cur.execute('SELECT DISTINCT level FROM winners WHERE meet_name = ?', (config.meet_name,))
    levels_in_winners = {row[0] for row in cur.fetchall()}
    for level in sorted(levels_in_results - levels_in_winners):
        cur.execute('SELECT COUNT(*) FROM results WHERE meet_name = ? AND level = ?',
                    (config.meet_name, level))
        n = cur.fetchone()[0]
        print(f"LEVEL_MISSING_WINNERS: Level '{level}' has {n} athletes in results but ZERO winners. "
              f"Check scores for this level.")


