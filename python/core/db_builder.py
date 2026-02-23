"""Unified database builder for gymnastics meet results.

Supports two winner determination strategies:
  - Score-based (max score per session+level+division+event): for MSO PDF and MSO HTML
  - Rank-based (rank=1 with fallback to max score): for ScoreCat
"""

import sqlite3
import os
from .models import MeetConfig


EVENTS = ['vault', 'bars', 'beam', 'floor', 'aa']


def build_database(db_path: str, config: MeetConfig, athletes: list[dict]) -> str:
    """Build a SQLite database from parsed athlete data.

    Args:
        db_path: Path for the output SQLite database.
        config: MeetConfig with state, meet_name, association, source_type.
        athletes: List of athlete dicts from an adapter.

    Returns:
        The db_path for convenience.
    """
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Create results table
    cur.execute('''CREATE TABLE results (
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

    # Insert all athletes
    for a in athletes:
        cur.execute('''INSERT INTO results
            (state, meet_name, association, name, gym, session, level, division,
             vault, bars, beam, floor, aa, rank, num)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (config.state, config.meet_name, config.association,
             a['name'], a['gym'], a['session'], a['level'], a['division'],
             a['vault'], a['bars'], a['beam'], a['floor'], a['aa'],
             a.get('rank'), a.get('num')))

    conn.commit()

    # Build winners table using appropriate strategy
    if config.source_type == 'scorecat':
        _build_winners_rank_based(conn, config, athletes)
    else:
        _build_winners_score_based(conn, config)

    conn.close()
    return db_path


def _create_winners_table(cur):
    """Create the winners table schema."""
    cur.execute('DROP TABLE IF EXISTS winners')
    cur.execute('''CREATE TABLE winners (
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


def _build_winners_score_based(conn: sqlite3.Connection, config: MeetConfig):
    """Determine winners by max score per session+level+division+event.

    Used for MSO PDF and MSO HTML sources.
    """
    cur = conn.cursor()
    _create_winners_table(cur)

    cur.execute('''SELECT DISTINCT session, level, division FROM results
                   WHERE meet_name = ?
                   ORDER BY level, division, session''', (config.meet_name,))
    combos = cur.fetchall()

    for session, level, division in combos:
        for event in EVENTS:
            # Find max score (exclude NULLs)
            cur.execute(f'''SELECT MAX({event}) FROM results
                           WHERE meet_name = ? AND session = ? AND level = ? AND division = ?
                             AND {event} IS NOT NULL''',
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
                cur.execute('''INSERT INTO winners
                    (state, meet_name, association, name, gym, session, level, division,
                     event, score, is_tie)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (config.state, config.meet_name, config.association,
                     name, gym, session, level, division, event, max_score, is_tie))

    conn.commit()


def _build_winners_rank_based(conn: sqlite3.Connection, config: MeetConfig,
                               athletes: list[dict]):
    """Determine winners by rank=1 with fallback to max score.

    Used for ScoreCat sources where ranks are provided.
    The adapter provides per-event ranks in the athlete dicts.
    We need to use a temporary table for rank lookups.
    """
    cur = conn.cursor()
    _create_winners_table(cur)

    # Create temporary rank lookup table from athlete data
    cur.execute('''CREATE TEMPORARY TABLE rank_lookup (
        name TEXT, gym TEXT, session TEXT, level TEXT, division TEXT,
        vault_rank INTEGER, bars_rank INTEGER, beam_rank INTEGER,
        floor_rank INTEGER, aa_rank INTEGER
    )''')

    for a in athletes:
        cur.execute('''INSERT INTO rank_lookup
            (name, gym, session, level, division,
             vault_rank, bars_rank, beam_rank, floor_rank, aa_rank)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (a['name'], a['gym'], a['session'], a['level'], a['division'],
             a.get('vault_rank'), a.get('bars_rank'), a.get('beam_rank'),
             a.get('floor_rank'), a.get('aa_rank')))

    cur.execute('''SELECT DISTINCT session, level, division FROM results
                   WHERE meet_name = ?
                   ORDER BY CAST(level AS INTEGER), division, session''',
                (config.meet_name,))
    combos = cur.fetchall()

    rank_cols = {
        'vault': 'vault_rank',
        'bars': 'bars_rank',
        'beam': 'beam_rank',
        'floor': 'floor_rank',
        'aa': 'aa_rank',
    }

    for session, level, division in combos:
        for event in EVENTS:
            rank_col = rank_cols[event]

            # Find all athletes with rank 1 who actually have a score > 0
            cur.execute(f'''SELECT r.name, r.gym, r.{event}
                           FROM results r
                           JOIN rank_lookup rl
                             ON r.name = rl.name AND r.gym = rl.gym
                             AND r.session = rl.session AND r.level = rl.level
                             AND r.division = rl.division
                           WHERE r.meet_name = ?
                             AND r.session = ? AND r.level = ? AND r.division = ?
                             AND rl.{rank_col} = 1
                             AND r.{event} IS NOT NULL AND r.{event} > 0''',
                        (config.meet_name, session, level, division))
            rank1_athletes = cur.fetchall()

            if not rank1_athletes:
                # Fallback: determine winner by max score
                cur.execute(f'''SELECT MAX({event}) FROM results
                               WHERE meet_name = ?
                                 AND session = ? AND level = ? AND division = ?
                                 AND {event} IS NOT NULL AND {event} > 0''',
                            (config.meet_name, session, level, division))
                max_score = cur.fetchone()[0]
                if max_score is None:
                    continue

                cur.execute(f'''SELECT name, gym, {event} FROM results
                               WHERE meet_name = ?
                                 AND session = ? AND level = ? AND division = ?
                                 AND {event} = ?''',
                            (config.meet_name, session, level, division, max_score))
                rank1_athletes = cur.fetchall()

            is_tie = 1 if len(rank1_athletes) > 1 else 0
            for row in rank1_athletes:
                name, gym, score = row[0], row[1], row[2]
                cur.execute('''INSERT INTO winners
                    (state, meet_name, association, name, gym, session, level, division,
                     event, score, is_tie)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                    (config.state, config.meet_name, config.association,
                     name, gym, session, level, division, event, score, is_tie))

    cur.execute('DROP TABLE IF EXISTS rank_lookup')
    conn.commit()
