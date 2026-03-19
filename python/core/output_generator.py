"""Unified output generator for gymnastics meet results.

Generates output types from the winners database:
  - Order forms by gym (grouped by gym with events)
  - Winners CSV with TRUE/FALSE event columns
"""
from __future__ import annotations

import sqlite3

from python.core.constants import EVENTS, EVENT_DISPLAY, EVENT_DISPLAY_SHORT


def _sort_names_by_division(rows, div_order):
    """Sort (name, division) rows by age group (youngest first), then name."""
    rows.sort(key=lambda r: (div_order.get(r[1], 99), r[0]))
    return [r[0] for r in rows]


def _shirt_level_first(cur, meet_name: str, levels: list, title: str | None,
                       div_order: dict = None) -> list[str]:
    """Iowa-style: title, then ## Level X, then ### Event."""
    if div_order is None:
        div_order = {}
    lines = []
    if title:
        lines.append(f'# {title}\n')

    for level in levels:
        lines.append(f'\n## Level {level}\n')

        for event in EVENTS:
            cur.execute('''SELECT DISTINCT name, division FROM winners
                          WHERE meet_name = ? AND event = ? AND level = ?''',
                        (meet_name, event, level))
            rows = cur.fetchall()

            if rows:
                names = _sort_names_by_division(rows, div_order)
                lines.append(f'### {EVENT_DISPLAY[event]}')
                for name in names:
                    lines.append(name)
                lines.append('')

    return lines


def _shirt_event_first(cur, meet_name: str, levels: list,
                       div_order: dict = None) -> list[str]:
    """CO/UT-style: ## Event, then names grouped by level (blank line separator)."""
    if div_order is None:
        div_order = {}
    lines = []
    for event in EVENTS:
        lines.append(f'\n## {EVENT_DISPLAY_SHORT[event]}\n')

        for level in levels:
            cur.execute('''SELECT DISTINCT name, division FROM winners
                          WHERE meet_name = ? AND event = ? AND level = ?''',
                        (meet_name, event, level))
            rows = cur.fetchall()

            if rows:
                names = _sort_names_by_division(rows, div_order)
                for name in names:
                    lines.append(name)
                lines.append('')

    return lines


def generate_order_forms(db_path: str, meet_name: str, output_path: str):
    """Generate order forms grouped by gym.

    Each gym section lists winners with their events won.
    """
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()

        # Get all gyms that have winners, alphabetical
        cur.execute('''SELECT DISTINCT gym FROM winners
                       WHERE meet_name = ?
                       ORDER BY gym''', (meet_name,))
        gyms = [row[0] for row in cur.fetchall()]

        lines = []
        for gym in gyms:
            lines.append('')
            lines.append('=' * 60)
            lines.append(f'  {gym}')
            lines.append('=' * 60)

            # Get all unique athlete entries for this gym
            cur.execute('''SELECT DISTINCT name, level, division FROM winners
                          WHERE meet_name = ? AND gym = ?
                          ORDER BY CAST(level AS INTEGER), division, name''',
                        (meet_name, gym))
            athlete_entries = cur.fetchall()

            seen = set()
            for name, level, division in athlete_entries:
                key = (name, level, division)
                if key in seen:
                    continue
                seen.add(key)

                # Get all events this athlete won at this level+division
                cur.execute('''SELECT event FROM winners
                              WHERE meet_name = ? AND name = ? AND gym = ?
                                AND level = ? AND division = ?
                              ORDER BY CASE event
                                WHEN 'vault' THEN 1
                                WHEN 'bars' THEN 2
                                WHEN 'beam' THEN 3
                                WHEN 'floor' THEN 4
                                WHEN 'aa' THEN 5
                              END''', (meet_name, name, gym, level, division))
                events = [EVENT_DISPLAY_SHORT[row[0]] for row in cur.fetchall()]

                lines.append(f'  {name} - {", ".join(events)}')
                lines.append(f'  Level {level} Division {division}')
                lines.append('')
    finally:
        conn.close()

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
