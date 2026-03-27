"""Unified database builder for gymnastics meet results.

Winner determination is always score-based (max score per session+level+division+event).
This ensures ties are properly detected regardless of data source — some sources
(e.g. ScoreCat) may assign sequential ranks to tied athletes instead of giving
both rank 1.
"""
from __future__ import annotations

import re
import sqlite3
import os
from .models import MeetConfig
from .constants import EVENTS


# Event code patterns that get attached to athlete names in some data sources.
# ScoreCat IES format: "Addie Wolff **V/BB/FX" or "Allie Thomas **UB/"
# MSO format: "Jane Smith VT,BB,FX" or "Jane Smith IES VT,BB"
_NAME_SUFFIX_PATTERN = re.compile(
    r'\s*\*{1,2}\s*'  # ** or * prefix
    r'(?:V|UB|BB|FX|VT|Be|Fl|Fx)'  # first event code
    r'(?:[/,\s]+(?:V|UB|BB|FX|VT|Be|Fl|Fx))*'  # additional event codes
    r'[/,\s]*$'  # trailing separators
)
_MSO_SUFFIX_PATTERN = re.compile(
    r'\s*(?:IES\s+)?'  # optional IES prefix
    r'(?:VT|UB|BB|FX|V|Be|Fl|Fx)'  # first event code
    r'(?:[,\s]+(?:VT|UB|BB|FX|V|Be|Fl|Fx))*'  # additional
    r'[,\s]*$'
)


def clean_athlete_name(name: str) -> str:
    """Strip event code suffixes from athlete names.

    Handles both ScoreCat IES format (**V/BB/FX) and MSO format (VT,BB,FX).
    Applied during database building so all sources get cleaned.
    """
    if not name:
        return name
    cleaned = _NAME_SUFFIX_PATTERN.sub('', name)
    if cleaned != name:
        return cleaned.strip()
    cleaned = _MSO_SUFFIX_PATTERN.sub('', name)
    return cleaned.strip()


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

        # Create results table if it doesn't exist
        cur.execute('''CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state TEXT,
            meet_name TEXT,
            association TEXT,
            name TEXT,
            gym TEXT,
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

        # Unique index as safety net for any duplicate rows within the same extraction
        cur.execute('''CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique
            ON results(meet_name, name, gym, session, level, division)''')

        # Covering index for winner determination queries (WHERE meet_name + session + level + division)
        cur.execute('CREATE INDEX IF NOT EXISTS idx_results_meet_sld ON results(meet_name, session, level, division)')

        # Meets metadata table — tracks source info and standardized names
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

        # Clean slate: delete ALL data in staging DB (not just this meet name).
        # The staging DB is single-meet by design. A previous build_database call
        # with a wrong source type could have left garbled records under a different
        # or empty meet_name that wouldn't be cleaned by a meet_name-specific DELETE.
        cur.execute('DELETE FROM results')
        # Winners and meets tables may not exist yet on first run — only delete if they do
        for table in ('winners', 'meets'):
            try:
                cur.execute(f'DELETE FROM {table}')
            except Exception:
                pass  # Table doesn't exist yet — will be created later

        names_cleaned = 0
        for a in athletes:
            raw_name = a['name']
            cleaned_name = clean_athlete_name(raw_name)
            if cleaned_name != raw_name:
                names_cleaned += 1
            cur.execute('''INSERT OR REPLACE INTO results
                (state, meet_name, association, name, gym, session, level, division,
                 vault, bars, beam, floor, aa, rank, num)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (config.state, config.meet_name, config.association,
                 cleaned_name, a['gym'], a['session'], a['level'], a['division'],
                 a['vault'], a['bars'], a['beam'], a['floor'], a['aa'],
                 a.get('rank'), a.get('num')))
        if names_cleaned > 0:
            print(f"Name cleaning: stripped event code suffixes from {names_cleaned} athlete names")

        conn.commit()

        # Normalize division case: merge "JR A"/"Jr A"/"JRA" variants.
        # When combining MSO + ScoreCat data, the same division may appear
        # with different casing (MSO: "JR A", ScoreCat: "Jr A").
        _normalize_division_case(cur, config.meet_name)
        conn.commit()

        # Always use score-based winner determination — ranks from data sources
        # may not handle ties correctly (e.g. ScoreCat assigns sequential ranks
        # to tied athletes instead of giving both rank 1)
        _build_winners_score_based(conn, config)
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
                    print(f"  Division merged: \"{variant}\" → \"{canonical}\" ({count} rows)")

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
        print(f"  ⚠️ EDGE CASE: {len(kept_solos)} athlete(s) competing alone at their level/division "
              f"(no other athletes in that division at the entire meet):")
        for s, l, d in kept_solos:
            cur.execute('SELECT name, gym FROM results WHERE meet_name = ? AND session = ? AND level = ? AND division = ?',
                        (meet_name, s, l, d))
            row = cur.fetchone()
            if row:
                print(f"    {row[0]} ({row[1]}) — S{s} L{l} Div {d}")
        print(f"  These athletes won all events by default. Verify with user if they should be on the shirt.")
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

    cur.execute('''SELECT DISTINCT session, level, division FROM results
                   WHERE meet_name = ?
                   ORDER BY level, division, session''', (config.meet_name,))
    combos = cur.fetchall()

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
                cur.execute('''INSERT OR REPLACE INTO winners
                    (state, meet_name, association, name, gym, session, level, division,
                     event, score, is_tie)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (config.state, config.meet_name, config.association,
                     name, gym, session, level, division, event, max_score, is_tie))

    conn.commit()


