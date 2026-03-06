"""Unified output generator for gymnastics meet results.

Generates three output types from the winners database:
  - Back-of-shirt markdown (names grouped for printing)
  - Order forms by gym (grouped by gym with events)
  - Winners CSV with TRUE/FALSE event columns
"""

import sqlite3
import csv

from python.core.constants import EVENTS, EVENT_DISPLAY, EVENT_DISPLAY_SHORT


def generate_back_of_shirt(db_path: str, meet_name: str, output_path: str,
                           shirt_title: str | None = None,
                           format: str = 'event_first'):
    """Generate back-of-shirt names markdown.

    Args:
        db_path: Path to SQLite database.
        meet_name: Meet name to filter by.
        output_path: Where to write the markdown.
        shirt_title: Optional title for level-first format (e.g. "2025 Iowa Dev State Champions").
        format: 'level_first' groups by level then event (Iowa style),
                'event_first' groups by event then level (CO/UT style).
    """
    from python.core.division_detector import detect_division_order

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Get division ordering for age-based sort (youngest first)
    div_order = detect_division_order(db_path, meet_name)

    # Get all levels present in winners, sorted numerically ascending
    cur.execute('''SELECT DISTINCT level FROM winners
                   WHERE meet_name = ?
                   ORDER BY CAST(level AS INTEGER)''', (meet_name,))
    levels = [row[0] for row in cur.fetchall()]

    if format == 'level_first':
        lines = _shirt_level_first(cur, meet_name, levels, shirt_title, div_order)
    else:
        lines = _shirt_event_first(cur, meet_name, levels, div_order)

    conn.close()

    with open(output_path, 'w') as f:
        f.write('\n'.join(lines))


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

    conn.close()

    with open(output_path, 'w') as f:
        f.write('\n'.join(lines))


def generate_winners_csv(db_path: str, meet_name: str, output_path: str,
                         division_order: dict):
    """Generate winners CSV with TRUE/FALSE event columns.

    Sorted by level desc, division youngest-to-oldest, session, AA score desc.
    """
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Get all unique winning athletes
    cur.execute('''SELECT DISTINCT w.name, w.gym, w.level, w.division, w.session
                  FROM winners w
                  WHERE w.meet_name = ?
                  ORDER BY w.name''', (meet_name,))
    athletes = cur.fetchall()

    rows = []
    for name, gym, level, division, session in athletes:
        # Check which events this athlete won
        cur.execute('''SELECT DISTINCT event FROM winners
                      WHERE meet_name = ? AND name = ? AND gym = ? AND level = ?''',
                    (meet_name, name, gym, level))
        won_events = {row[0] for row in cur.fetchall()}

        # Get AA score from results table for sorting
        cur.execute('''SELECT aa FROM results
                      WHERE meet_name = ? AND name = ? AND gym = ?
                        AND level = ? AND division = ? AND session = ?''',
                    (meet_name, name, gym, level, division, session))
        aa_row = cur.fetchone()
        aa_score = aa_row[0] if aa_row and aa_row[0] is not None else 0.0

        rows.append({
            'name': name,
            'gym name': gym,
            'level': level,
            'division': division,
            'session': session,
            'aa_score': aa_score,
            'Vault': 'TRUE' if 'vault' in won_events else 'FALSE',
            'Bars': 'TRUE' if 'bars' in won_events else 'FALSE',
            'Beam': 'TRUE' if 'beam' in won_events else 'FALSE',
            'Floor': 'TRUE' if 'floor' in won_events else 'FALSE',
            'AA': 'TRUE' if 'aa' in won_events else 'FALSE',
        })

    # Sort: level desc, division youngest-to-oldest, session, AA score desc
    rows.sort(key=lambda r: (
        -int(r['level']) if r['level'].isdigit() else 0,
        division_order.get(r['division'], 99),
        r['session'],
        -r['aa_score']
    ))

    conn.close()

    with open(output_path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=['name', 'gym name', 'level',
                                                'Vault', 'Bars', 'Beam', 'Floor', 'AA'])
        writer.writeheader()
        for row in rows:
            out = {k: v for k, v in row.items()
                   if k not in ('division', 'session', 'aa_score')}
            writer.writerow(out)
