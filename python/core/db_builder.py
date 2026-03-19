"""Unified database builder for gymnastics meet results.

Winner determination is always score-based (max score per session+level+division+event).
This ensures ties are properly detected regardless of data source — some sources
(e.g. ScoreCat) may assign sequential ranks to tied athletes instead of giving
both rank 1.
"""
from __future__ import annotations

import sqlite3
import os
from .models import MeetConfig
from .constants import EVENTS


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

        # Delete existing data for this meet first (clean slate for full re-runs),
        # then INSERT OR REPLACE as safety net for edge-case duplicates within the data
        cur.execute('DELETE FROM results WHERE meet_name = ?', (config.meet_name,))

        for a in athletes:
            cur.execute('''INSERT OR REPLACE INTO results
                (state, meet_name, association, name, gym, session, level, division,
                 vault, bars, beam, floor, aa, rank, num)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (config.state, config.meet_name, config.association,
                 a['name'], a['gym'], a['session'], a['level'], a['division'],
                 a['vault'], a['bars'], a['beam'], a['floor'], a['aa'],
                 a.get('rank'), a.get('num')))

        conn.commit()

        # Always use score-based winner determination — ranks from data sources
        # may not handle ties correctly (e.g. ScoreCat assigns sequential ranks
        # to tied athletes instead of giving both rank 1)
        _build_winners_score_based(conn, config)
    finally:
        conn.close()
    return db_path


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
        is_tie INTEGER
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

    if excluded:
        kept = len(solo_groups) - len(excluded)
        print(f"  Solo sessions: {len(excluded)} out-of-session group(s) excluded, "
              f"{kept} legitimate solo division(s) kept")
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


