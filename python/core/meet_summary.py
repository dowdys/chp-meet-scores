"""Meet summary report generator.

Produces a readable text file with key facts about a processed meet:
- Total unique athletes and winners
- Athletes per shirt page
- Level and session breakdown
- Gym count
- Solo-session exclusions
"""

import sqlite3

from python.core.constants import (
    XCEL_MAP, XCEL_PRESTIGE_ORDER as XCEL_ORDER,
    EVENTS as EVENT_KEYS,
    LINE_HEIGHT_RATIO, LEVEL_GAP, DEFAULT_NAME_SIZE, MAX_PAGE_FILL,
    MIN_NAME_SIZE, NAMES_BOTTOM_Y, NAMES_START_Y,
)
from python.core.layout_engine import (
    get_winners_by_event_and_level, bin_pack_levels,
    precompute_shirt_data,
)


def generate_meet_summary(db_path: str, meet_name: str, output_path: str,
                          layout=None,
                          level_groups: str = None, exclude_levels: str = None,
                          precomputed: dict = None):
    """Generate a meet summary text file."""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()

        lines = []
        lines.append(f'MEET SUMMARY: {meet_name}')
        lines.append('=' * 60)
        lines.append('')

        # --- Total athletes ---
        cur.execute('SELECT COUNT(DISTINCT name) FROM results WHERE meet_name = ?',
                    (meet_name,))
        total_athletes = cur.fetchone()[0]
        lines.append(f'Total athletes:  {total_athletes}')

        # --- Total unique winners ---
        cur.execute('SELECT COUNT(DISTINCT name) FROM winners WHERE meet_name = ?',
                    (meet_name,))
        total_winners = cur.fetchone()[0]
        lines.append(f'Total unique winners (on shirt):  {total_winners}')

        # --- Total winner entries (including multi-event) ---
        cur.execute('SELECT COUNT(*) FROM winners WHERE meet_name = ?',
                    (meet_name,))
        total_entries = cur.fetchone()[0]
        lines.append(f'Total winner entries:  {total_entries}')

        # --- Tied winners ---
        cur.execute('SELECT COUNT(*) FROM winners WHERE meet_name = ? AND is_tie = 1',
                    (meet_name,))
        tied = cur.fetchone()[0]
        lines.append(f'Tied entries:  {tied}')
        lines.append('')

        # --- Gyms ---
        cur.execute('SELECT COUNT(DISTINCT gym) FROM results WHERE meet_name = ?',
                    (meet_name,))
        total_gyms = cur.fetchone()[0]
        lines.append(f'Total gyms:  {total_gyms}')

        cur.execute('SELECT COUNT(DISTINCT gym) FROM winners WHERE meet_name = ?',
                    (meet_name,))
        winner_gyms = cur.fetchone()[0]
        lines.append(f'Gyms with winners:  {winner_gyms}')
        lines.append('')

        # --- Sessions ---
        cur.execute('SELECT DISTINCT session FROM results WHERE meet_name = ? ORDER BY session',
                    (meet_name,))
        sessions = [r[0] for r in cur.fetchall()]
        lines.append(f'Sessions:  {len(sessions)}  ({", ".join(sessions)})')

        # Solo sessions — distinguish excluded (out-of-session) from kept (sole competitor)
        cur.execute('''SELECT session, level, division, COUNT(DISTINCT name) as cnt
                       FROM results WHERE meet_name = ?
                       GROUP BY session, level, division HAVING cnt = 1''',
                    (meet_name,))
        solos = cur.fetchall()

        # Find which level+division combos have real competition elsewhere
        cur.execute('''SELECT level, division
                       FROM results WHERE meet_name = ?
                       GROUP BY session, level, division
                       HAVING COUNT(DISTINCT name) >= 2''',
                    (meet_name,))
        has_competition = {(r[0], r[1]) for r in cur.fetchall()}

        excluded_solos = [(s, l, d) for s, l, d, _ in solos if (l, d) in has_competition]
        kept_solos = [(s, l, d) for s, l, d, _ in solos if (l, d) not in has_competition]

        if excluded_solos:
            lines.append(f'Solo-session groups (excluded from winners):  {len(excluded_solos)}')
            for sess, lvl, div in excluded_solos:
                lines.append(f'  Session {sess}, Level {lvl}, Division {div}')

        if kept_solos:
            lines.append(f'⚠️ Sole-competitor edge cases (included as winners):  {len(kept_solos)}')
            for sess, lvl, div in kept_solos:
                cur.execute('''SELECT name, gym FROM results
                              WHERE meet_name = ? AND session = ? AND level = ? AND division = ?''',
                            (meet_name, sess, lvl, div))
                row = cur.fetchone()
                if row:
                    lines.append(f'  {row[0]} ({row[1]}) — Session {sess}, Level {lvl}, Division {div}')
                    lines.append(f'    Only athlete at this level/division. Won all events by default.')
                    lines.append(f'    Verify with meet director if they should be on the championship shirt.')

        if not excluded_solos and not kept_solos:
            lines.append('Solo-session groups:  None')
        lines.append('')

        # --- Levels (canonical order: Xcel prestige, then numbered descending) ---
        cur.execute('SELECT DISTINCT level FROM results WHERE meet_name = ?',
                    (meet_name,))
        all_levels = [r[0] for r in cur.fetchall()]

        from python.core.layout_engine import _sort_level_group
        all_levels = _sort_level_group(all_levels)
        lines.append(f'Levels:  {len(all_levels)}  ({", ".join(all_levels)})')
        lines.append('')

        # --- Winners per level ---
        lines.append('WINNERS PER LEVEL')
        lines.append('-' * 40)
        for level in all_levels:
            cur.execute('SELECT COUNT(DISTINCT name) FROM winners WHERE meet_name = ? AND level = ?',
                        (meet_name, level))
            cnt = cur.fetchone()[0]
            display = XCEL_MAP.get(level, f'Level {level}') if level in XCEL_MAP else f'Level {level}'
            lines.append(f'  {display:20s}  {cnt} unique winners')
        lines.append('')

        # --- Winners per event ---
        lines.append('WINNERS PER EVENT')
        lines.append('-' * 40)
        from python.core.constants import EVENT_DISPLAY
        for event in EVENT_KEYS:
            cur.execute('SELECT COUNT(DISTINCT name) FROM winners WHERE meet_name = ? AND event = ?',
                        (meet_name, event))
            cnt = cur.fetchone()[0]
            lines.append(f'  {EVENT_DISPLAY[event]:15s}  {cnt} unique winners')
        lines.append('')

        # --- Winners per gym ---
        lines.append('WINNERS PER GYM')
        lines.append('-' * 40)
        cur.execute('''SELECT gym, COUNT(DISTINCT name) as cnt
                       FROM winners WHERE meet_name = ?
                       GROUP BY gym ORDER BY gym''',
                    (meet_name,))
        gym_rows = cur.fetchall()
        for gym, cnt in gym_rows:
            lines.append(f'  {gym:30s}  {cnt} unique winners')
        lines.append('')

        # --- Winners per level per gym ---
        lines.append('WINNERS PER LEVEL PER GYM')
        lines.append('-' * 40)
        cur.execute('''SELECT gym, level, COUNT(DISTINCT name) as cnt
                       FROM winners WHERE meet_name = ?
                       GROUP BY gym, level
                       ORDER BY gym, CASE
                         WHEN level IN ('XB','XS','XG','XP','XD','XSA') THEN 0
                         ELSE 1 END,
                         CASE level
                           WHEN 'XSA' THEN 1 WHEN 'XD' THEN 2 WHEN 'XP' THEN 3
                           WHEN 'XG' THEN 4 WHEN 'XS' THEN 5 WHEN 'XB' THEN 6
                           ELSE CAST(level AS INTEGER) + 10 END''',
                    (meet_name,))
        current_gym = None
        for gym, level, cnt in cur.fetchall():
            if gym != current_gym:
                if current_gym is not None:
                    lines.append('')
                lines.append(f'  {gym}')
                current_gym = gym
            display = XCEL_MAP.get(level, f'Level {level}') if level in XCEL_MAP else f'Level {level}'
            lines.append(f'    {display:20s}  {cnt} winners')
        lines.append('')
    finally:
        conn.close()

    # --- Shirt page breakdown ---
    if precomputed is not None:
        pre = precomputed
    else:
        pre = precompute_shirt_data(db_path, meet_name,
                                    layout=layout,
                                    level_groups=level_groups,
                                    exclude_levels=exclude_levels)
    page_groups = pre['page_groups']
    data = pre['data']

    if page_groups:
        lines.append('SHIRT BACK PAGES')
        lines.append('-' * 40)
        total_shirt_names = 0
        for page_num, (label, group_levels) in enumerate(page_groups, 1):
            # Count unique names across all events on this page
            page_names = set()
            for level in group_levels:
                for event in EVENT_KEYS:
                    names = data[event].get(level, [])
                    page_names.update(names)
            total_shirt_names += len(page_names)

            level_list = ', '.join(group_levels)
            lines.append(f'  Page {page_num}: {label} ({level_list})')
            lines.append(f'         {len(page_names)} unique athletes on this page')

        lines.append(f'\n  Total pages: {len(page_groups)}')
        lines.append(f'  Total unique athletes across all pages: {total_shirt_names}')
        lines.append('')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
