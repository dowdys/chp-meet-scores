"""Meet summary report generator.

Produces a readable text file with key facts about a processed meet:
- Total unique athletes and winners
- Athletes per shirt page
- Level and session breakdown
- Gym count
- Solo-session exclusions
"""

import sqlite3

from python.core.pdf_generator import (
    XCEL_MAP, XCEL_ORDER, EVENT_KEYS,
    LINE_HEIGHT_RATIO, LEVEL_GAP, DEFAULT_NAME_SIZE, MAX_PAGE_FILL,
    MIN_NAME_SIZE, NAMES_BOTTOM_Y, NAMES_START_Y,
    _get_winners_by_event_and_level, _bin_pack_levels,
)


def generate_meet_summary(db_path: str, meet_name: str, output_path: str,
                          line_spacing: float = None, level_gap: float = None,
                          max_fill: float = None, max_font_size: float = None):
    """Generate a meet summary text file."""
    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    conn = sqlite3.connect(db_path)
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

    # Solo sessions
    cur.execute('''SELECT session, level, division, COUNT(DISTINCT name) as cnt
                   FROM results WHERE meet_name = ?
                   GROUP BY session, level, division HAVING cnt = 1''',
                (meet_name,))
    solos = cur.fetchall()
    if solos:
        lines.append(f'Solo-session groups (excluded from winners):  {len(solos)}')
        for sess, lvl, div, _ in solos:
            lines.append(f'  Session {sess}, Level {lvl}, Division {div}')
    else:
        lines.append('Solo-session groups:  None')
    lines.append('')

    # --- Levels ---
    cur.execute('SELECT DISTINCT level FROM results WHERE meet_name = ? ORDER BY CAST(level AS INTEGER)',
                (meet_name,))
    all_levels = [r[0] for r in cur.fetchall()]
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

    conn.close()

    # --- Shirt page breakdown ---
    levels, data = _get_winners_by_event_and_level(db_path, meet_name)
    if levels:
        xcel_levels = [lv for lv in levels if lv in XCEL_MAP]
        numbered_levels = [lv for lv in levels if lv not in XCEL_MAP]

        xcel_levels.sort(key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                         if XCEL_MAP.get(lv) in XCEL_ORDER else 99)
        numbered_levels.sort(key=lambda lv: -int(lv) if lv.isdigit() else 0)

        available = (NAMES_BOTTOM_Y - NAMES_START_Y) * mfill
        page_groups = []

        if xcel_levels:
            xcel_groups = _bin_pack_levels(xcel_levels, data, available, lhr, lgap, mxfs)
            for group in xcel_groups:
                page_groups.append(('XCEL', group))
        if numbered_levels:
            groups = _bin_pack_levels(numbered_levels, data, available, lhr, lgap, mxfs)
            for group in groups:
                nums = sorted([int(lv) for lv in group if lv.isdigit()])
                if len(nums) >= 2:
                    label = f'LEVELS {nums[-1]}-{nums[0]}'
                elif len(nums) == 1:
                    label = f'LEVEL {nums[0]}'
                else:
                    label = 'LEVELS'
                page_groups.append((label, group))

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
