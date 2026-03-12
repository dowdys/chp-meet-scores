"""Enhanced back-of-shirt PDF generator for gymnastics meet results.

Generates championship-style PDFs with:
- Small-caps title and state line
- Red filled oval with level group label
- Small-caps column headers with red underlines
- Red line level dividers with letter-spaced text
- Dynamic font sizing: keeps names as BIG as possible
- Tight line spacing (1.15 ratio) to maximize name size
- Auto-grouping: Xcel bin-packed, numbered levels bin-packed
- Balanced bin-packing avoids nearly-empty last pages
- No page should be more than ~90% full
- Copyright footer
"""

import sqlite3
import math
import fitz  # PyMuPDF

# --- Page layout constants (letter: 612 x 792 pt) ---
PAGE_W = 612
PAGE_H = 792

from python.core.constants import EVENTS as EVENT_KEYS, EVENT_HEADERS as COL_HEADERS

COL_CENTERS = [72, 192, 306, 420, 546]

# Colors
RED = (1, 0, 0)
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)
YELLOW_HL = (1.0, 1.0, 0.0)

# Default text content
DEFAULT_SPORT = 'GYMNASTICS'
DEFAULT_TITLE_PREFIX = 'STATE CHAMPIONS OF'
DEFAULT_COPYRIGHT = '\u00a9 C. H. Publishing'

# Xcel level mapping (abbreviation and full-name forms)
XCEL_MAP = {
    'XSA': 'SAPPHIRE', 'XD': 'DIAMOND', 'XP': 'PLATINUM',
    'XG': 'GOLD', 'XS': 'SILVER', 'XB': 'BRONZE',
    'Sapphire': 'SAPPHIRE', 'Diamond': 'DIAMOND', 'Platinum': 'PLATINUM',
    'Gold': 'GOLD', 'Silver': 'SILVER', 'Bronze': 'BRONZE',
    'SAPPHIRE': 'SAPPHIRE', 'DIAMOND': 'DIAMOND', 'PLATINUM': 'PLATINUM',
    'GOLD': 'GOLD', 'SILVER': 'SILVER', 'BRONZE': 'BRONZE',
}
# Prestige order (highest first)
XCEL_ORDER = ['SAPPHIRE', 'DIAMOND', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE']

# Layout Y positions
COPYRIGHT_Y = PAGE_H - 8
NAMES_BOTTOM_Y = PAGE_H - 18

# Font sizes
TITLE1_LARGE = 18
TITLE1_SMALL = 14
TITLE2_LARGE = 20
TITLE2_SMALL = 15
HEADER_LARGE = 11
HEADER_SMALL = 8
DEFAULT_NAME_SIZE = 9
MIN_NAME_SIZE = 6.5
LEVEL_DIVIDER_SIZE = 10
COPYRIGHT_SIZE = 7
OVAL_LABEL_SIZE = 12

# Tight spacing: 1.15 ratio keeps names close together, maximizing font size
LINE_HEIGHT_RATIO = 1.15
LEVEL_GAP = 6

FONT_REGULAR = 'Times-Roman'
FONT_BOLD = 'Times-Bold'

# Target page fill: don't fill more than 90% of available space
MAX_PAGE_FILL = 0.90


def _parse_hex_color(hex_str):
    """Parse a hex color string (e.g. '#CC0000' or 'CC0000') to (r, g, b) tuple 0-1."""
    h = hex_str.lstrip('#')
    if len(h) != 6:
        return RED  # fallback
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def _compute_layout(t1l=TITLE1_LARGE, t2l=TITLE2_LARGE):
    """Compute Y positions for page elements based on title font sizes.

    Returns (title1_y, title2_y, oval_y, headers_y, names_start_y).
    """
    t1_y = 14 + int(t1l)
    t2_y = t1_y + round(t1l * 1.375)
    ov_y = t2_y + round(t2l * 1.2)
    hd_y = ov_y + 24
    ns_y = hd_y + 16
    return t1_y, t2_y, ov_y, hd_y, ns_y


# Default layout Y positions (computed from default title sizes)
TITLE_LINE1_Y, TITLE_LINE2_Y, OVAL_CENTER_Y, HEADERS_Y, NAMES_START_Y = \
    _compute_layout()


def precompute_shirt_data(db_path, meet_name, name_sort='age',
                          line_spacing=None, level_gap=None,
                          max_fill=None, min_font_size=None,
                          max_font_size=None, max_shirt_pages=None,
                          title1_size=None, title2_size=None,
                          level_groups=None, exclude_levels=None,
                          copyright=None, accent_color=None,
                          font_family=None, sport=None,
                          title_prefix=None, header_size=None,
                          divider_size=None):
    """Pre-compute shirt layout data for reuse across multiple renders.

    Args:
        exclude_levels: Comma-separated levels to intentionally exclude
            (e.g. "3,4" to drop levels with no real data). Without this,
            all levels with winners are included.

    Returns a dict with levels, data, page_groups, and resolved layout params.
    """
    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mfs = min_font_size if min_font_size is not None else MIN_NAME_SIZE
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    # Title sizes (large/small caps pairs)
    t1l = title1_size if title1_size is not None else TITLE1_LARGE
    t1s = round(t1l * 0.75)
    t2l = title2_size if title2_size is not None else TITLE2_LARGE
    t2s = round(t2l * 0.75)

    # Visual style params
    cr = copyright if copyright is not None else DEFAULT_COPYRIGHT
    sp = sport if sport is not None else DEFAULT_SPORT
    tp = title_prefix if title_prefix is not None else DEFAULT_TITLE_PREFIX
    hl = header_size if header_size is not None else HEADER_LARGE
    hs = round(hl * 0.72)
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    accent = _parse_hex_color(accent_color) if accent_color else RED
    if font_family == 'sans-serif':
        f_reg, f_bold = 'Helvetica', 'Helvetica-Bold'
    else:
        f_reg, f_bold = FONT_REGULAR, FONT_BOLD

    # Compute Y positions from title sizes
    title1_y, title2_y, oval_y, headers_y, names_start = _compute_layout(t1l, t2l)

    levels, data = _get_winners_by_event_and_level(db_path, meet_name,
                                                    name_sort=name_sort)

    # Intentionally exclude specific levels (e.g. levels with no real data)
    if exclude_levels:
        if isinstance(exclude_levels, str):
            excl = {lv.strip() for lv in exclude_levels.split(',')}
        else:
            excl = set(exclude_levels)
        levels = [lv for lv in levels if lv not in excl]
        for event in EVENT_KEYS:
            for lv in excl:
                data[event].pop(lv, None)

    style = {
        'copyright': cr, 'sport': sp, 'title_prefix': tp,
        'header_large': hl, 'header_small': hs, 'divider_size': ds,
        'accent_color': accent, 'font_regular': f_reg, 'font_bold': f_bold,
    }

    empty_result = {
        'levels': [], 'data': {}, 'page_groups': [],
        'lhr': lhr, 'lgap': lgap, 'mfill': mfill, 'mfs': mfs, 'mxfs': mxfs,
        't1l': t1l, 't1s': t1s, 't2l': t2l, 't2s': t2s,
        'title1_y': title1_y, 'title2_y': title2_y,
        'oval_y': oval_y, 'headers_y': headers_y,
        'names_start_y': names_start,
        **style,
    }

    if not levels:
        return empty_result

    # Classify levels into Xcel and numbered
    xcel_levels = []
    numbered_levels = []
    for level in levels:
        if level in XCEL_MAP:
            xcel_levels.append(level)
        else:
            numbered_levels.append(level)

    xcel_levels.sort(key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                     if XCEL_MAP.get(lv) in XCEL_ORDER else 99)
    numbered_levels.sort(key=lambda lv: -int(lv) if lv.isdigit() else 0)

    available = (NAMES_BOTTOM_Y - names_start) * mfill

    # Custom level groups override auto bin-packing
    if level_groups:
        level_set = set(levels)
        page_groups = _parse_level_groups(level_groups, level_set)
    else:
        # Auto bin-packing
        page_groups = []
        if xcel_levels:
            xcel_groups = _bin_pack_levels(xcel_levels, data, available,
                                           lhr, lgap, mxfs)
            for group in xcel_groups:
                page_groups.append(('XCEL', group))

        if numbered_levels:
            groups = _bin_pack_levels(numbered_levels, data, available,
                                      lhr, lgap, mxfs)
            for group in groups:
                page_groups.append(_label_numbered_group(group))

        # If max_shirt_pages is set and we have too many pages, try shrinking
        # the bin-pack font estimate to merge groups. Uses multi-resolution
        # search (1.0 → 0.5 → 0.2 → 0.1) for efficiency.
        if max_shirt_pages and len(page_groups) > max_shirt_pages:
            def _groups_at_size(try_size):
                new_groups = []
                if xcel_levels:
                    for g in _bin_pack_levels(xcel_levels, data, available,
                                              lhr, lgap, try_size):
                        new_groups.append(('XCEL', g))
                if numbered_levels:
                    for g in _bin_pack_levels(numbered_levels, data, available,
                                              lhr, lgap, try_size):
                        new_groups.append(_label_numbered_group(g))
                return new_groups

            best_size = mfs
            best_groups = _groups_at_size(mfs)

            for step in [1.0, 0.5, 0.2, 0.1]:
                candidate = best_size + step
                while candidate <= mxfs + 0.001:
                    candidate_groups = _groups_at_size(candidate)
                    if len(candidate_groups) <= max_shirt_pages:
                        best_size = candidate
                        best_groups = candidate_groups
                        candidate += step
                    else:
                        break

            page_groups = best_groups

    return {'levels': levels, 'data': data, 'page_groups': page_groups,
            'lhr': lhr, 'lgap': lgap, 'mfill': mfill,
            'mfs': mfs, 'mxfs': mxfs,
            't1l': t1l, 't1s': t1s, 't2l': t2l, 't2s': t2s,
            'title1_y': title1_y, 'title2_y': title2_y,
            'oval_y': oval_y, 'headers_y': headers_y,
            'names_start_y': names_start,
            **style}


def _label_numbered_group(group):
    """Derive an oval label from a list of numbered levels."""
    nums = sorted([int(lv) for lv in group if lv.isdigit()])
    if len(nums) >= 2:
        label = f'LEVELS {nums[0]}-{nums[-1]}'
    elif len(nums) == 1:
        label = f'LEVEL {nums[0]}'
    else:
        label = 'LEVELS'
    return (label, group)


def _parse_level_groups(level_groups, level_set):
    """Parse custom level groups into page_groups list.

    level_groups: semicolon-separated groups, comma-separated levels.
        E.g. "XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"
    level_set: set of levels that exist in the data.

    Any levels in level_set that are NOT mentioned in level_groups are
    automatically appended to the last group so no winners are silently
    dropped.
    """
    if isinstance(level_groups, str):
        raw_groups = level_groups.split(';')
    else:
        raw_groups = level_groups

    page_groups = []
    included = set()
    for group_str in raw_groups:
        if isinstance(group_str, str):
            group_levels = [lv.strip() for lv in group_str.split(',')]
        else:
            group_levels = list(group_str)
        # Filter to only levels that exist in the data
        group_levels = [lv for lv in group_levels if lv in level_set]
        if not group_levels:
            continue
        included.update(group_levels)
        page_groups.append((_label_group(group_levels), group_levels))

    # Auto-include any levels with winners that were not mentioned
    missing = level_set - included
    if missing and page_groups:
        # Sort missing levels consistently: numbered descending, then Xcel
        missing_xcel = sorted([lv for lv in missing if lv in XCEL_MAP],
                               key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                               if XCEL_MAP.get(lv) in XCEL_ORDER else 99)
        missing_numbered = sorted([lv for lv in missing if lv not in XCEL_MAP],
                                   key=lambda lv: -int(lv) if lv.isdigit() else 0)
        missing_sorted = missing_numbered + missing_xcel
        # Append to last group
        last_label, last_levels = page_groups[-1]
        last_levels.extend(missing_sorted)
        page_groups[-1] = (_label_group(last_levels), last_levels)

    return page_groups


def _label_group(group_levels):
    """Derive a page label from a list of levels."""
    xcel_in = [lv for lv in group_levels if lv in XCEL_MAP]
    numbered_in = [lv for lv in group_levels if lv not in XCEL_MAP]
    if xcel_in and not numbered_in:
        return 'XCEL'
    elif numbered_in and not xcel_in:
        nums = sorted([int(lv) for lv in numbered_in if lv.isdigit()])
        if len(nums) >= 2:
            return f'LEVELS {nums[0]}-{nums[-1]}'
        elif len(nums) == 1:
            return f'LEVEL {nums[0]}'
        else:
            return 'LEVELS'
    else:
        # Mixed Xcel + numbered
        nums = sorted([int(lv) for lv in numbered_in if lv.isdigit()])
        if nums:
            return f'XCEL & LEVELS {nums[0]}-{nums[-1]}'
        else:
            return 'XCEL'


def add_shirt_back_pages(doc, precomputed, athlete_name, year, state):
    """Append back-of-shirt page(s) to doc with a red star next to athlete_name.

    Only includes page groups where the athlete appears. Each matching page
    group gets one page appended to doc.
    """
    page_groups = precomputed['page_groups']
    data = precomputed['data']
    lhr = precomputed['lhr']
    lgap = precomputed['lgap']
    mfill = precomputed['mfill']
    mfs = precomputed['mfs']
    mxfs = precomputed['mxfs']
    t1l = precomputed['t1l']
    t1s = precomputed['t1s']
    t2l = precomputed['t2l']
    t2s = precomputed['t2s']
    p_title1_y = precomputed['title1_y']
    p_title2_y = precomputed['title2_y']
    p_oval_y = precomputed['oval_y']
    p_headers_y = precomputed['headers_y']
    p_names_start = precomputed['names_start_y']

    # Style params
    s_copyright = precomputed.get('copyright', DEFAULT_COPYRIGHT)
    s_sport = precomputed.get('sport', DEFAULT_SPORT)
    s_prefix = precomputed.get('title_prefix', DEFAULT_TITLE_PREFIX)
    s_hl = precomputed.get('header_large', HEADER_LARGE)
    s_hs = precomputed.get('header_small', HEADER_SMALL)
    s_ds = precomputed.get('divider_size', LEVEL_DIVIDER_SIZE)
    s_accent = precomputed.get('accent_color', RED)
    s_freg = precomputed.get('font_regular', FONT_REGULAR)
    s_fbold = precomputed.get('font_bold', FONT_BOLD)

    star_set = {athlete_name}

    for label, group_levels in page_groups:
        # Check if athlete appears on this page group
        found = False
        for level in group_levels:
            for event in EVENT_KEYS:
                if athlete_name in data[event].get(level, []):
                    found = True
                    break
            if found:
                break
        if not found:
            continue

        page = doc.new_page(width=PAGE_W, height=PAGE_H)

        # Title lines
        _draw_small_caps(page, PAGE_W / 2, p_title1_y,
                         f'{year} {s_sport}', t1l, t1s, font=s_fbold)
        _draw_small_caps(page, PAGE_W / 2, p_title2_y,
                         f'{s_prefix} {state.upper()}',
                         t2l, t2s, font=s_fbold)

        # Oval
        _draw_oval(page, label, p_oval_y, color=s_accent, font=s_fbold)

        # Column headers with underlines
        for i, header in enumerate(COL_HEADERS):
            _draw_small_caps(page, COL_CENTERS[i], p_headers_y,
                             header, s_hl, s_hs, font=s_fbold)
            hw = _measure_small_caps_width(header, s_hl, s_hs, font=s_fbold)
            line_y = p_headers_y + 3
            page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                           fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                           color=s_accent, width=0.5)

        # Determine best font size
        font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs,
                                    names_start_y=p_names_start, divider_size=s_ds)
        line_height = font_size * lhr

        # Draw each level's names with star
        y = p_names_start
        for level in group_levels:
            y += lgap
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            _draw_level_divider(page, y, divider_text, color=s_accent,
                                size=s_ds, font=s_fbold)
            y += s_ds * 1.3

            max_names = 0
            for col_idx, event in enumerate(EVENT_KEYS):
                names = data[event].get(level, [])
                if names:
                    _draw_names(page, y, col_idx, names, font_size,
                                line_height, star_names=star_set,
                                font_regular=s_freg, font_bold=s_fbold,
                                accent_color=s_accent)
                    max_names = max(max_names, len(names))
            y += max_names * line_height + 1

        _draw_copyright(page, text=s_copyright, font=s_freg)


def generate_shirt_pdf(db_path: str, meet_name: str, output_path: str,
                       year: str = '2026', state: str = 'Maryland',
                       line_spacing: float = None, level_gap: float = None,
                       max_fill: float = None, min_font_size: float = None,
                       max_font_size: float = None,
                       name_sort: str = 'age',
                       max_shirt_pages: int = None,
                       title1_size: float = None,
                       title2_size: float = None,
                       level_groups: str = None,
                       exclude_levels: str = None,
                       copyright: str = None, accent_color: str = None,
                       font_family: str = None, sport: str = None,
                       title_prefix: str = None, header_size: float = None,
                       divider_size: float = None):
    """Generate enhanced back-of-shirt PDF."""
    # Use precompute to get shared data
    pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                line_spacing=line_spacing, level_gap=level_gap,
                                max_fill=max_fill, min_font_size=min_font_size,
                                max_font_size=max_font_size,
                                max_shirt_pages=max_shirt_pages,
                                title1_size=title1_size,
                                title2_size=title2_size,
                                level_groups=level_groups,
                                exclude_levels=exclude_levels,
                                copyright=copyright, accent_color=accent_color,
                                font_family=font_family, sport=sport,
                                title_prefix=title_prefix,
                                header_size=header_size,
                                divider_size=divider_size)
    levels = pre['levels']
    data = pre['data']
    page_groups = pre['page_groups']
    lhr = pre['lhr']
    lgap = pre['lgap']
    mfill = pre['mfill']
    mfs = pre['mfs']
    mxfs = pre['mxfs']
    t1l = pre['t1l']
    t1s = pre['t1s']
    t2l = pre['t2l']
    t2s = pre['t2s']
    p_title1_y = pre['title1_y']
    p_title2_y = pre['title2_y']
    p_oval_y = pre['oval_y']
    p_headers_y = pre['headers_y']
    p_names_start = pre['names_start_y']
    # Style params
    s_copyright = pre['copyright']
    s_sport = pre['sport']
    s_prefix = pre['title_prefix']
    s_hl = pre['header_large']
    s_hs = pre['header_small']
    s_ds = pre['divider_size']
    s_accent = pre['accent_color']
    s_freg = pre['font_regular']
    s_fbold = pre['font_bold']

    if not levels:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    # Generate PDF
    doc = fitz.open()

    for label, group_levels in page_groups:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)

        # Title lines (small caps)
        _draw_small_caps(page, PAGE_W / 2, p_title1_y,
                         f'{year} {s_sport}', t1l, t1s, font=s_fbold)
        _draw_small_caps(page, PAGE_W / 2, p_title2_y,
                         f'{s_prefix} {state.upper()}',
                         t2l, t2s, font=s_fbold)

        # Oval with group label
        _draw_oval(page, label, p_oval_y, color=s_accent, font=s_fbold)

        # Column headers (small caps) with underlines
        for i, header in enumerate(COL_HEADERS):
            _draw_small_caps(page, COL_CENTERS[i], p_headers_y,
                             header, s_hl, s_hs, font=s_fbold)
            hw = _measure_small_caps_width(header, s_hl, s_hs, font=s_fbold)
            line_y = p_headers_y + 3
            page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                           fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                           color=s_accent, width=0.5)

        # Determine best font size for this page's content
        font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs,
                                    names_start_y=p_names_start,
                                    divider_size=s_ds)
        line_height = font_size * lhr

        # Draw each level's names
        y = p_names_start
        for level in group_levels:
            y += lgap

            # Level divider text
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            _draw_level_divider(page, y, divider_text, color=s_accent,
                                size=s_ds, font=s_fbold)
            y += s_ds * 1.3

            # Names in 5 columns
            max_names = 0
            for col_idx, event in enumerate(EVENT_KEYS):
                names = data[event].get(level, [])
                if names:
                    _draw_names(page, y, col_idx, names, font_size, line_height,
                                font_regular=s_freg, font_bold=s_fbold,
                                accent_color=s_accent)
                    max_names = max(max_names, len(names))
            y += max_names * line_height + 1

        # Copyright footer
        _draw_copyright(page, text=s_copyright, font=s_freg)

    doc.save(output_path)
    doc.close()


# --- Data query ---

def _get_winners_by_event_and_level(db_path: str, meet_name: str,
                                    name_sort: str = 'age'):
    """Get winner names organized by event and level.

    Args:
        name_sort: 'age' sorts by division age group (youngest first), then
                   alphabetically within each group. 'alpha' sorts purely
                   alphabetically ignoring divisions.
    """
    from python.core.division_detector import detect_division_order

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute('''SELECT DISTINCT level FROM winners
                   WHERE meet_name = ?''', (meet_name,))
    levels = [row[0] for row in cur.fetchall()]

    # Get division ordering for age-based sort
    div_order = detect_division_order(db_path, meet_name)

    data = {}
    for event in EVENT_KEYS:
        data[event] = {}
        for level in levels:
            # Get names with their division for sorting
            cur.execute('''SELECT DISTINCT name, division FROM winners
                          WHERE meet_name = ? AND event = ? AND level = ?''',
                        (meet_name, event, level))
            rows = cur.fetchall()
            if rows:
                if name_sort == 'alpha':
                    rows.sort(key=lambda r: r[0])
                else:
                    # Sort by division age (youngest first), then name
                    rows.sort(key=lambda r: (div_order.get(r[1], 99), r[0]))
                data[event][level] = [r[0] for r in rows]

    conn.close()
    return levels, data


# --- Layout helpers ---

def _level_height(level, data, line_height, level_gap):
    """Calculate the vertical space one level needs."""
    max_names = max(len(data[event].get(level, [])) for event in EVENT_KEYS)
    return level_gap + LEVEL_DIVIDER_SIZE * 1.3 + max_names * line_height + 1


def _bin_pack_levels(levels, data, available_height,
                     line_height_ratio=LINE_HEIGHT_RATIO,
                     level_gap=LEVEL_GAP,
                     max_font_size=DEFAULT_NAME_SIZE):
    """Bin-pack levels into page-sized groups with balanced distribution.

    Two-pass approach:
    1. Greedy pack to find the actual minimum page count (accounts for
       large levels that can't combine with others).
    2. Balanced redistribution targeting equal height per page, so the
       last page isn't nearly empty.
    """
    line_height = max_font_size * line_height_ratio

    # Calculate height for each level
    heights = []
    for level in levels:
        h = _level_height(level, data, line_height, level_gap)
        heights.append(h)

    total = sum(heights)
    if total <= available_height:
        return [levels]

    # Pass 1: greedy pack to find actual page count
    greedy_pages = []
    current = []
    current_h = 0
    for i, level in enumerate(levels):
        h = heights[i]
        if current and current_h + h > available_height:
            greedy_pages.append(current)
            current = [level]
            current_h = h
        else:
            current.append(level)
            current_h += h
    if current:
        greedy_pages.append(current)

    num_pages = len(greedy_pages)
    if num_pages <= 1:
        return greedy_pages

    # Pass 2: balanced redistribution
    target = total / num_pages

    balanced_pages = []
    current = []
    current_h = 0
    remaining_pages = num_pages

    for i, level in enumerate(levels):
        h = heights[i]
        remaining_levels = len(levels) - i

        if current and remaining_pages > 1:
            over_target = current_h >= target * 0.85
            would_overflow = current_h + h > available_height
            enough_left = remaining_levels >= remaining_pages
            if (over_target and enough_left) or would_overflow:
                balanced_pages.append(current)
                current = []
                current_h = 0
                remaining_pages -= 1

        current.append(level)
        current_h += h

    if current:
        balanced_pages.append(current)
    return balanced_pages


def _fit_font_size(levels, data,
                   line_height_ratio=LINE_HEIGHT_RATIO,
                   level_gap=LEVEL_GAP,
                   max_page_fill=MAX_PAGE_FILL,
                   min_name_size=MIN_NAME_SIZE,
                   max_font_size=DEFAULT_NAME_SIZE,
                   names_start_y=NAMES_START_Y,
                   divider_size=None):
    """Find the largest font size that fits all levels on page.

    Uses multi-resolution search (like a B-tree index): tests at
    progressively finer steps (1.0 -> 0.5 -> 0.2 -> 0.1) instead
    of scanning every 0.1 increment linearly. Precise to 0.1pt.
    """
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    available = (NAMES_BOTTOM_Y - names_start_y) * max_page_fill

    def _total_height(size):
        lh = size * line_height_ratio
        return sum(
            level_gap + ds * 1.3 +
            max(len(data[event].get(level, [])) for event in EVENT_KEYS) * lh + 1
            for level in levels
        )

    # Quick check: if max fits, use it
    if _total_height(max_font_size) <= available:
        return max_font_size

    # Quick check: if min doesn't fit, use min anyway
    if _total_height(min_name_size) > available:
        return min_name_size

    # Multi-resolution search: start at min (definitely fits) and
    # step upward at progressively finer increments
    best = min_name_size
    for step in [1.0, 0.5, 0.2, 0.1]:
        candidate = best + step
        while candidate <= max_font_size + 0.001:
            if _total_height(candidate) <= available:
                best = candidate
                candidate += step
            else:
                break

    return round(best, 1)


# --- Drawing functions ---

def _draw_small_caps(page, center_x, y, text, large_size, small_size,
                     color=None, font=None):
    """Draw text in small caps, centered horizontally.

    First letter of each word at large_size, rest at small_size.
    All characters rendered uppercase.
    """
    if color is None:
        color = BLACK
    if font is None:
        font = FONT_BOLD
    total_width = _measure_small_caps_width(text, large_size, small_size, font=font)
    x = center_x - total_width / 2

    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            space_w = fitz.get_text_length(' ', fontname=font, fontsize=large_size)
            x += space_w

        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            page.insert_text(fitz.Point(x, y), ch_upper,
                             fontname=font, fontsize=fs, color=color)
            x += fitz.get_text_length(ch_upper, fontname=font, fontsize=fs)


def _measure_small_caps_width(text, large_size, small_size, font=None):
    """Measure total width of small-caps text."""
    if font is None:
        font = FONT_BOLD
    total = 0
    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            total += fitz.get_text_length(' ', fontname=font, fontsize=large_size)
        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            total += fitz.get_text_length(ch_upper, fontname=font, fontsize=fs)
    return total


def _draw_oval(page, label, y_center, color=None, font=None):
    """Draw a filled oval with white text label."""
    if color is None:
        color = RED
    if font is None:
        font = FONT_BOLD
    tw = fitz.get_text_length(label, fontname=font, fontsize=OVAL_LABEL_SIZE)
    # Oval spans from Bars column to Floor column (wider than just text)
    text_w = tw + 40
    col_span_w = (COL_CENTERS[3] + 60) - (COL_CENTERS[1] - 60)
    oval_w = max(text_w, col_span_w)
    oval_h = 22

    x0 = PAGE_W / 2 - oval_w / 2
    x1 = PAGE_W / 2 + oval_w / 2
    y0 = y_center - oval_h / 2
    y1 = y_center + oval_h / 2

    rect = fitz.Rect(x0, y0, x1, y1)
    page.draw_oval(rect, color=color, fill=color)

    # White text centered in oval (y positions at baseline)
    text_x = PAGE_W / 2 - tw / 2
    text_y = y_center + OVAL_LABEL_SIZE * 0.35
    page.insert_text(fitz.Point(text_x, text_y), label,
                     fontname=font, fontsize=OVAL_LABEL_SIZE, color=WHITE)


def _draw_level_divider(page, y, level_text, color=None, size=None, font=None):
    """Draw lines flanking letter-spaced level text."""
    if color is None:
        color = RED
    if size is None:
        size = LEVEL_DIVIDER_SIZE
    if font is None:
        font = FONT_BOLD
    spaced = _space_text(level_text)
    tw = fitz.get_text_length(spaced, fontname=font, fontsize=size)

    text_x = PAGE_W / 2 - tw / 2
    page.insert_text(fitz.Point(text_x, y), spaced,
                     fontname=font, fontsize=size, color=color)

    # Horizontal lines on either side of the text
    line_y = y - size * 0.35
    gap = 8
    left_margin = 40
    right_margin = PAGE_W - 40

    page.draw_line(fitz.Point(left_margin, line_y),
                   fitz.Point(text_x - gap, line_y),
                   color=color, width=0.75)
    page.draw_line(fitz.Point(text_x + tw + gap, line_y),
                   fitz.Point(right_margin, line_y),
                   color=color, width=0.75)


def _space_text(text):
    """Add letter spacing: 'LEVEL 10' -> 'L E V E L  1 0'."""
    words = text.split()
    spaced_words = [' '.join(list(word)) for word in words]
    return '  '.join(spaced_words)


def _draw_names(page, y, col_idx, names, font_size, line_height,
                highlight_names=None, star_names=None,
                font_regular=None, font_bold=None, accent_color=None):
    """Draw a centered list of names in the given column.

    Args:
        highlight_names: Optional set of name strings. Names in this set
            render in bold with a yellow highlight rectangle behind them.
        star_names: Optional set of name strings. Names in this set get
            a large red ★ drawn just to the left of the name text.
    """
    if font_regular is None:
        font_regular = FONT_REGULAR
    if font_bold is None:
        font_bold = FONT_BOLD
    if accent_color is None:
        accent_color = RED
    cx = COL_CENTERS[col_idx]
    current_y = y
    for name in names:
        is_highlighted = highlight_names and name in highlight_names
        font = font_bold if is_highlighted else font_regular
        tw = fitz.get_text_length(name, fontname=font, fontsize=font_size)
        name_x = cx - tw / 2
        # Draw yellow highlight rectangle behind highlighted names
        if is_highlighted:
            pad_x = 2
            rect = fitz.Rect(name_x - pad_x,
                             current_y - font_size * 0.82,
                             name_x + tw + pad_x,
                             current_y + font_size * 0.25)
            page.draw_rect(rect, fill=YELLOW_HL, color=YELLOW_HL, width=0)
        # Draw star polygon to the left of the name
        if star_names and name in star_names:
            star_r = font_size * 0.65
            star_cx = name_x - star_r - 3
            star_cy = current_y - font_size * 0.3
            _draw_star_polygon(page, star_cx, star_cy, star_r, star_r * 0.4,
                               color=accent_color)
        page.insert_text(fitz.Point(name_x, current_y), name,
                         fontname=font, fontsize=font_size, color=BLACK)
        current_y += line_height


def _draw_star_polygon(page, cx, cy, outer_r, inner_r, color=RED):
    """Draw a filled 5-pointed star as a polygon."""
    points = []
    for i in range(10):
        angle = math.radians(90 + i * 36)
        r = outer_r if i % 2 == 0 else inner_r
        x = cx + r * math.cos(angle)
        y = cy - r * math.sin(angle)
        points.append(fitz.Point(x, y))
    shape = page.new_shape()
    shape.draw_polyline(points + [points[0]])
    shape.finish(fill=color, color=color)
    shape.commit()


def _draw_copyright(page, text=None, font=None):
    """Draw copyright footer at page bottom."""
    if text is None:
        text = DEFAULT_COPYRIGHT
    if font is None:
        font = FONT_REGULAR
    tw = fitz.get_text_length(text, fontname=font, fontsize=COPYRIGHT_SIZE)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, COPYRIGHT_Y), text,
                     fontname=font, fontsize=COPYRIGHT_SIZE, color=BLACK)


# --- Gym Highlights PDF ---

def _get_winners_with_gym(db_path, meet_name):
    """Get a mapping of winner name -> gym."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute('SELECT DISTINCT name, gym FROM winners WHERE meet_name = ?',
                (meet_name,))
    result = {row[0]: row[1] for row in cur.fetchall()}
    conn.close()
    return result


def _get_all_winner_gyms(db_path, meet_name):
    """Get sorted list of all gyms that have winners."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute('SELECT DISTINCT gym FROM winners WHERE meet_name = ? ORDER BY gym',
                (meet_name,))
    result = [row[0] for row in cur.fetchall()]
    conn.close()
    return result


def _draw_arched_text(page, center_x, center_y, text, font_size, radius,
                      start_angle_deg, sweep_deg, color=None, font=None):
    """Draw text along a circular arc.

    Characters are placed along the arc and rotated to follow the curve tangent.
    start_angle_deg is the angle of the first character (0=top, positive=clockwise).
    sweep_deg is the total angular span the text covers.
    """
    if color is None:
        color = RED
    if font is None:
        font = FONT_BOLD
    if not text:
        return

    # Measure each character width to distribute along the arc
    char_widths = []
    for ch in text:
        w = fitz.get_text_length(ch, fontname=font, fontsize=font_size)
        char_widths.append(w)
    total_width = sum(char_widths)

    # Convert to radians; use negative sweep for left-to-right on top arc
    n = len(text)
    if n == 1:
        angles = [math.radians(start_angle_deg)]
    else:
        # Distribute characters evenly across the sweep
        step = sweep_deg / (n - 1)
        angles = [math.radians(start_angle_deg + i * step) for i in range(n)]

    for i, ch in enumerate(text):
        angle = angles[i]
        # Position on circle (math convention: 0=right, pi/2=up)
        # We use: 0 deg = top of circle, clockwise positive
        # Convert: circle_angle = pi/2 - angle
        cx = center_x + radius * math.sin(angle)
        cy = center_y - radius * math.cos(angle)

        # Rotation: character should be tangent to the arc
        # Tangent angle in degrees (for morph rotation)
        rot_deg = math.degrees(angle)

        pivot = fitz.Point(cx, cy)
        mat = fitz.Matrix(1, 0, 0, 1, 0, 0).prerotate(rot_deg)
        morph = (pivot, mat)

        # Center each character on its arc position
        cw = char_widths[i]
        page.insert_text(fitz.Point(cx - cw / 2, cy + font_size * 0.35),
                         ch, fontname=font, fontsize=font_size,
                         color=color, morph=morph)


def generate_gym_highlights_pdf(db_path, meet_name, output_path,
                                year='2026', state='Maryland',
                                line_spacing=None, level_gap=None,
                                max_fill=None, min_font_size=None,
                                max_font_size=None, name_sort='age',
                                max_shirt_pages=None,
                                title1_size=None, title2_size=None,
                                level_groups=None, exclude_levels=None,
                                copyright=None, accent_color=None,
                                font_family=None, sport=None,
                                title_prefix=None, header_size=None,
                                divider_size=None):
    """Generate a gym highlights version of the back-of-shirt PDF.

    For each gym (alphabetically), generates the same back-of-shirt pages
    but with that gym's athletes highlighted in bold. The gym name is arched
    in the top-left and top-right corners.

    Only includes pages that contain at least one of that gym's athletes.
    """
    # Reuse precompute for consistent grouping with generate_shirt_pdf
    pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                line_spacing=line_spacing, level_gap=level_gap,
                                max_fill=max_fill, min_font_size=min_font_size,
                                max_font_size=max_font_size,
                                max_shirt_pages=max_shirt_pages,
                                title1_size=title1_size,
                                title2_size=title2_size,
                                level_groups=level_groups,
                                exclude_levels=exclude_levels,
                                copyright=copyright, accent_color=accent_color,
                                font_family=font_family, sport=sport,
                                title_prefix=title_prefix,
                                header_size=header_size,
                                divider_size=divider_size)
    levels = pre['levels']
    data = pre['data']
    page_groups = pre['page_groups']
    lhr = pre['lhr']
    lgap = pre['lgap']
    mfill = pre['mfill']
    mfs = pre['mfs']
    mxfs = pre['mxfs']
    t1l = pre['t1l']
    t1s = pre['t1s']
    t2l = pre['t2l']
    t2s = pre['t2s']
    p_title1_y = pre['title1_y']
    p_title2_y = pre['title2_y']
    # Style params
    s_copyright = pre['copyright']
    s_sport = pre['sport']
    s_prefix = pre['title_prefix']
    s_hl = pre['header_large']
    s_hs = pre['header_small']
    s_ds = pre['divider_size']
    s_accent = pre['accent_color']
    s_freg = pre['font_regular']
    s_fbold = pre['font_bold']

    if not levels:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    name_to_gym = _get_winners_with_gym(db_path, meet_name)
    all_gyms = _get_all_winner_gyms(db_path, meet_name)

    # Pre-compute which names appear on each page group
    def _names_on_page(group_levels):
        names = set()
        for level in group_levels:
            for event in EVENT_KEYS:
                for name in data[event].get(level, []):
                    names.add(name)
        return names

    doc = fitz.open()

    # Gym highlights layout: shifted down to accommodate gym name below title
    gh_gym_name_y = p_title2_y + round(t2l * 0.8)
    gh_oval_y = gh_gym_name_y + 24
    gh_headers_y = gh_oval_y + 24
    gh_names_start = gh_headers_y + 16

    for gym in all_gyms:
        # Build highlight set: all athletes from this gym
        highlight_names = {name for name, g in name_to_gym.items() if g == gym}

        # Dynamic font size for gym name line (shrink if name is very long)
        gym_display = gym.upper()
        gym_name_large = 14
        gym_name_small = 10
        gym_w = _measure_small_caps_width(gym_display, gym_name_large, gym_name_small, font=s_fbold)
        while gym_w > PAGE_W - 80 and gym_name_large > 9:
            gym_name_large -= 1
            gym_name_small = round(gym_name_large * 0.72)
            gym_w = _measure_small_caps_width(gym_display, gym_name_large, gym_name_small, font=s_fbold)

        for label, group_levels in page_groups:
            # Only include pages that have at least one highlighted athlete
            page_names = _names_on_page(group_levels)
            if not page_names.intersection(highlight_names):
                continue

            page = doc.new_page(width=PAGE_W, height=PAGE_H)

            # Title lines (small caps)
            _draw_small_caps(page, PAGE_W / 2, p_title1_y,
                             f'{year} {s_sport}', t1l, t1s, font=s_fbold)
            _draw_small_caps(page, PAGE_W / 2, p_title2_y,
                             f'{s_prefix} {state.upper()}',
                             t2l, t2s, font=s_fbold)

            # Gym name centered below title in accent color
            _draw_small_caps(page, PAGE_W / 2, gh_gym_name_y,
                             gym_display, gym_name_large, gym_name_small,
                             color=s_accent, font=s_fbold)

            # Oval with group label (shifted down)
            _draw_oval(page, label, gh_oval_y, color=s_accent, font=s_fbold)

            # Column headers with underlines (shifted down)
            for i, header in enumerate(COL_HEADERS):
                _draw_small_caps(page, COL_CENTERS[i], gh_headers_y,
                                 header, s_hl, s_hs, font=s_fbold)
                hw = _measure_small_caps_width(header, s_hl, s_hs, font=s_fbold)
                line_y = gh_headers_y + 3
                page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                               fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                               color=s_accent, width=0.5)

            # Determine best font size (using shifted start position)
            font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs,
                                        names_start_y=gh_names_start, divider_size=s_ds)
            line_height = font_size * lhr

            # Draw each level's names with yellow highlighting
            y = gh_names_start
            for level in group_levels:
                y += lgap
                if level in XCEL_MAP:
                    divider_text = XCEL_MAP[level]
                else:
                    divider_text = f'LEVEL {level}'
                _draw_level_divider(page, y, divider_text, color=s_accent,
                                    size=s_ds, font=s_fbold)
                y += s_ds * 1.3

                max_names = 0
                for col_idx, event in enumerate(EVENT_KEYS):
                    names = data[event].get(level, [])
                    if names:
                        _draw_names(page, y, col_idx, names, font_size,
                                    line_height, highlight_names=highlight_names,
                                    font_regular=s_freg, font_bold=s_fbold,
                                    accent_color=s_accent)
                        max_names = max(max_names, len(names))
                y += max_names * line_height + 1

            _draw_copyright(page, text=s_copyright, font=s_freg)

    doc.save(output_path)
    doc.close()
