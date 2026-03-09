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

# Layout Y positions (tight margins to maximize name space)
TITLE_LINE1_Y = 30
TITLE_LINE2_Y = 52
OVAL_CENTER_Y = 76
HEADERS_Y = 100
NAMES_START_Y = 116
COPYRIGHT_Y = PAGE_H - 8
NAMES_BOTTOM_Y = PAGE_H - 18

# Font sizes
TITLE1_LARGE = 16
TITLE1_SMALL = 12
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


def precompute_shirt_data(db_path, meet_name, name_sort='age',
                          line_spacing=None, level_gap=None,
                          max_fill=None, min_font_size=None,
                          max_font_size=None, max_shirt_pages=None):
    """Pre-compute shirt layout data for reuse across multiple renders.

    Returns a dict with levels, data, page_groups, and resolved layout params.
    """
    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mfs = min_font_size if min_font_size is not None else MIN_NAME_SIZE
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    levels, data = _get_winners_by_event_and_level(db_path, meet_name,
                                                    name_sort=name_sort)
    if not levels:
        return {'levels': [], 'data': {}, 'page_groups': [],
                'lhr': lhr, 'lgap': lgap, 'mfill': mfill,
                'mfs': mfs, 'mxfs': mxfs}

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

    # Build page groups: (oval_label, [levels])
    page_groups = []
    available = (NAMES_BOTTOM_Y - NAMES_START_Y) * mfill

    if xcel_levels:
        xcel_groups = _bin_pack_levels(xcel_levels, data, available, lhr, lgap, mxfs)
        for group in xcel_groups:
            page_groups.append(('XCEL', group))

    if numbered_levels:
        groups = _bin_pack_levels(numbered_levels, data, available, lhr, lgap, mxfs)
        for group in groups:
            nums = sorted([int(lv) for lv in group if lv.isdigit()])
            if len(nums) >= 2:
                label = f'LEVELS {nums[0]}-{nums[-1]}'
            elif len(nums) == 1:
                label = f'LEVEL {nums[0]}'
            else:
                label = 'LEVELS'
            page_groups.append((label, group))

    # If max_shirt_pages is set and we have too many pages, try shrinking
    # the bin-pack font estimate to merge groups
    if max_shirt_pages and len(page_groups) > max_shirt_pages:
        target_xcel = len([g for g in page_groups if g[0] == 'XCEL'])
        target_numbered = max_shirt_pages - target_xcel
        if target_numbered >= 1 and numbered_levels:
            # Try progressively smaller font estimates until numbered levels
            # fit within target_numbered pages
            for try_size_10x in range(int(mxfs * 10) - 1, int(mfs * 10) - 1, -1):
                try_size = try_size_10x / 10
                groups = _bin_pack_levels(numbered_levels, data, available,
                                         lhr, lgap, try_size)
                if len(groups) <= target_numbered:
                    # Rebuild page_groups with the tighter grouping
                    page_groups = []
                    if xcel_levels:
                        for group in _bin_pack_levels(xcel_levels, data,
                                                      available, lhr, lgap, mxfs):
                            page_groups.append(('XCEL', group))
                    for group in groups:
                        nums = sorted([int(lv) for lv in group if lv.isdigit()])
                        if len(nums) >= 2:
                            label = f'LEVELS {nums[0]}-{nums[-1]}'
                        elif len(nums) == 1:
                            label = f'LEVEL {nums[0]}'
                        else:
                            label = 'LEVELS'
                        page_groups.append((label, group))
                    break

    return {'levels': levels, 'data': data, 'page_groups': page_groups,
            'lhr': lhr, 'lgap': lgap, 'mfill': mfill,
            'mfs': mfs, 'mxfs': mxfs}


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
        _draw_small_caps(page, PAGE_W / 2, TITLE_LINE1_Y,
                         f'{year} GYMNASTICS', TITLE1_LARGE, TITLE1_SMALL)
        _draw_small_caps(page, PAGE_W / 2, TITLE_LINE2_Y,
                         f'STATE CHAMPIONS OF {state.upper()}',
                         TITLE2_LARGE, TITLE2_SMALL)

        # Red oval
        _draw_oval(page, label, OVAL_CENTER_Y)

        # Column headers with red underlines
        for i, header in enumerate(COL_HEADERS):
            _draw_small_caps(page, COL_CENTERS[i], HEADERS_Y,
                             header, HEADER_LARGE, HEADER_SMALL)
            hw = _measure_small_caps_width(header, HEADER_LARGE, HEADER_SMALL)
            line_y = HEADERS_Y + 3
            page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                           fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                           color=RED, width=0.5)

        # Determine best font size
        font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs)
        line_height = font_size * lhr

        # Draw each level's names with star
        y = NAMES_START_Y
        for level in group_levels:
            y += lgap
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            _draw_level_divider(page, y, divider_text)
            y += LEVEL_DIVIDER_SIZE * 1.3

            max_names = 0
            for col_idx, event in enumerate(EVENT_KEYS):
                names = data[event].get(level, [])
                if names:
                    _draw_names(page, y, col_idx, names, font_size,
                                line_height, star_names=star_set)
                    max_names = max(max_names, len(names))
            y += max_names * line_height + 1

        _draw_copyright(page)


def generate_shirt_pdf(db_path: str, meet_name: str, output_path: str,
                       year: str = '2026', state: str = 'Maryland',
                       line_spacing: float = None, level_gap: float = None,
                       max_fill: float = None, min_font_size: float = None,
                       max_font_size: float = None,
                       name_sort: str = 'age',
                       max_shirt_pages: int = None):
    """Generate enhanced back-of-shirt PDF.

    Args:
        db_path: Path to SQLite database.
        meet_name: Meet name to filter by.
        output_path: Where to save the PDF.
        year: Championship year for title.
        state: State name for title.
        line_spacing: Line height ratio (default 1.15). Lower = tighter.
        level_gap: Vertical gap before each level section (default 6).
        max_fill: Max page fill fraction (default 0.90). E.g. 0.85 = 85%.
        min_font_size: Minimum name font size in points (default 6.5).
        max_font_size: Maximum/starting name font size in points (default 9).
        name_sort: 'age' (default) sorts by division age group youngest-first,
                   'alpha' sorts alphabetically.
    """
    # Use precompute to get shared data
    pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                line_spacing=line_spacing, level_gap=level_gap,
                                max_fill=max_fill, min_font_size=min_font_size,
                                max_font_size=max_font_size,
                                max_shirt_pages=max_shirt_pages)
    levels = pre['levels']
    data = pre['data']
    page_groups = pre['page_groups']
    lhr = pre['lhr']
    lgap = pre['lgap']
    mfill = pre['mfill']
    mfs = pre['mfs']
    mxfs = pre['mxfs']

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
        _draw_small_caps(page, PAGE_W / 2, TITLE_LINE1_Y,
                         f'{year} GYMNASTICS', TITLE1_LARGE, TITLE1_SMALL)
        _draw_small_caps(page, PAGE_W / 2, TITLE_LINE2_Y,
                         f'STATE CHAMPIONS OF {state.upper()}',
                         TITLE2_LARGE, TITLE2_SMALL)

        # Red oval with group label
        _draw_oval(page, label, OVAL_CENTER_Y)

        # Column headers (small caps) with red underlines
        for i, header in enumerate(COL_HEADERS):
            _draw_small_caps(page, COL_CENTERS[i], HEADERS_Y,
                             header, HEADER_LARGE, HEADER_SMALL)
            # Red underline below header
            hw = _measure_small_caps_width(header, HEADER_LARGE, HEADER_SMALL)
            line_y = HEADERS_Y + 3
            page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                           fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                           color=RED, width=0.5)

        # Determine best font size for this page's content
        font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs)
        line_height = font_size * lhr

        # Draw each level's names
        y = NAMES_START_Y
        for level in group_levels:
            y += lgap

            # Level divider text
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            _draw_level_divider(page, y, divider_text)
            y += LEVEL_DIVIDER_SIZE * 1.3

            # Names in 5 columns
            max_names = 0
            for col_idx, event in enumerate(EVENT_KEYS):
                names = data[event].get(level, [])
                if names:
                    _draw_names(page, y, col_idx, names, font_size, line_height)
                    max_names = max(max_names, len(names))
            y += max_names * line_height + 1

        # Copyright footer
        _draw_copyright(page)

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
                   names_start_y=NAMES_START_Y):
    """Find the largest font size that fits all levels on page.

    Tries max_font_size down to min_name_size in 0.1 steps.
    Targets max_page_fill fraction of available space.
    """
    available = (NAMES_BOTTOM_Y - names_start_y) * max_page_fill
    min_10x = int(min_name_size * 10)
    max_10x = int(max_font_size * 10)

    for size_10x in range(max_10x, min_10x - 1, -1):
        size = size_10x / 10
        lh = size * line_height_ratio
        total = 0
        for level in levels:
            max_names = max(
                len(data[event].get(level, []))
                for event in EVENT_KEYS
            )
            total += level_gap + LEVEL_DIVIDER_SIZE * 1.3 + max_names * lh + 1
        if total <= available:
            return size

    return min_name_size


# --- Drawing functions ---

def _draw_small_caps(page, center_x, y, text, large_size, small_size,
                     color=None):
    """Draw text in small caps, centered horizontally.

    First letter of each word at large_size, rest at small_size.
    All characters rendered uppercase.
    """
    if color is None:
        color = BLACK
    total_width = _measure_small_caps_width(text, large_size, small_size)
    x = center_x - total_width / 2

    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            space_w = fitz.get_text_length(' ', fontname=FONT_BOLD, fontsize=large_size)
            x += space_w

        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            page.insert_text(fitz.Point(x, y), ch_upper,
                             fontname=FONT_BOLD, fontsize=fs, color=color)
            x += fitz.get_text_length(ch_upper, fontname=FONT_BOLD, fontsize=fs)


def _measure_small_caps_width(text, large_size, small_size):
    """Measure total width of small-caps text."""
    total = 0
    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            total += fitz.get_text_length(' ', fontname=FONT_BOLD, fontsize=large_size)
        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            total += fitz.get_text_length(ch_upper, fontname=FONT_BOLD, fontsize=fs)
    return total


def _draw_oval(page, label, y_center):
    """Draw a red filled oval with white text label."""
    tw = fitz.get_text_length(label, fontname=FONT_BOLD, fontsize=OVAL_LABEL_SIZE)
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
    page.draw_oval(rect, color=RED, fill=RED)

    # White text centered in oval (y positions at baseline)
    text_x = PAGE_W / 2 - tw / 2
    text_y = y_center + OVAL_LABEL_SIZE * 0.35
    page.insert_text(fitz.Point(text_x, text_y), label,
                     fontname=FONT_BOLD, fontsize=OVAL_LABEL_SIZE, color=WHITE)


def _draw_level_divider(page, y, level_text):
    """Draw red lines flanking letter-spaced level text."""
    spaced = _space_text(level_text)
    tw = fitz.get_text_length(spaced, fontname=FONT_BOLD, fontsize=LEVEL_DIVIDER_SIZE)

    text_x = PAGE_W / 2 - tw / 2
    page.insert_text(fitz.Point(text_x, y), spaced,
                     fontname=FONT_BOLD, fontsize=LEVEL_DIVIDER_SIZE, color=RED)

    # Red horizontal lines on either side of the text
    line_y = y - LEVEL_DIVIDER_SIZE * 0.35
    gap = 8
    left_margin = 40
    right_margin = PAGE_W - 40

    page.draw_line(fitz.Point(left_margin, line_y),
                   fitz.Point(text_x - gap, line_y),
                   color=RED, width=0.75)
    page.draw_line(fitz.Point(text_x + tw + gap, line_y),
                   fitz.Point(right_margin, line_y),
                   color=RED, width=0.75)


def _space_text(text):
    """Add letter spacing: 'LEVEL 10' -> 'L E V E L  1 0'."""
    words = text.split()
    spaced_words = [' '.join(list(word)) for word in words]
    return '  '.join(spaced_words)


def _draw_names(page, y, col_idx, names, font_size, line_height,
                highlight_names=None, star_names=None):
    """Draw a centered list of names in the given column.

    Args:
        highlight_names: Optional set of name strings. Names in this set
            render in bold with a yellow highlight rectangle behind them.
        star_names: Optional set of name strings. Names in this set get
            a large red ★ drawn just to the left of the name text.
    """
    cx = COL_CENTERS[col_idx]
    current_y = y
    for name in names:
        is_highlighted = highlight_names and name in highlight_names
        font = FONT_BOLD if is_highlighted else FONT_REGULAR
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
        # Draw large red star polygon to the left of the name
        if star_names and name in star_names:
            star_r = font_size * 0.65
            star_cx = name_x - star_r - 3
            star_cy = current_y - font_size * 0.3
            _draw_star_polygon(page, star_cx, star_cy, star_r, star_r * 0.4)
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


def _draw_copyright(page):
    """Draw copyright footer at page bottom."""
    text = '\u00a9 C. H. Publishing'
    tw = fitz.get_text_length(text, fontname=FONT_REGULAR, fontsize=COPYRIGHT_SIZE)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, COPYRIGHT_Y), text,
                     fontname=FONT_REGULAR, fontsize=COPYRIGHT_SIZE, color=BLACK)


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
                      start_angle_deg, sweep_deg):
    """Draw text along a circular arc.

    Characters are placed along the arc and rotated to follow the curve tangent.
    start_angle_deg is the angle of the first character (0=top, positive=clockwise).
    sweep_deg is the total angular span the text covers.
    """
    if not text:
        return

    # Measure each character width to distribute along the arc
    char_widths = []
    for ch in text:
        w = fitz.get_text_length(ch, fontname=FONT_BOLD, fontsize=font_size)
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
                         ch, fontname=FONT_BOLD, fontsize=font_size,
                         color=RED, morph=morph)


def generate_gym_highlights_pdf(db_path, meet_name, output_path,
                                year='2026', state='Maryland',
                                line_spacing=None, level_gap=None,
                                max_fill=None, min_font_size=None,
                                max_font_size=None, name_sort='age',
                                max_shirt_pages=None):
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
                                max_shirt_pages=max_shirt_pages)
    levels = pre['levels']
    data = pre['data']
    page_groups = pre['page_groups']
    lhr = pre['lhr']
    lgap = pre['lgap']
    mfill = pre['mfill']
    mfs = pre['mfs']
    mxfs = pre['mxfs']

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
    gh_gym_name_y = 68
    gh_oval_y = 92
    gh_headers_y = 116
    gh_names_start = 132

    for gym in all_gyms:
        # Build highlight set: all athletes from this gym
        highlight_names = {name for name, g in name_to_gym.items() if g == gym}

        # Dynamic font size for gym name line (shrink if name is very long)
        gym_display = gym.upper()
        gym_name_large = 14
        gym_name_small = 10
        gym_w = _measure_small_caps_width(gym_display, gym_name_large, gym_name_small)
        while gym_w > PAGE_W - 80 and gym_name_large > 9:
            gym_name_large -= 1
            gym_name_small = round(gym_name_large * 0.72)
            gym_w = _measure_small_caps_width(gym_display, gym_name_large, gym_name_small)

        for label, group_levels in page_groups:
            # Only include pages that have at least one highlighted athlete
            page_names = _names_on_page(group_levels)
            if not page_names.intersection(highlight_names):
                continue

            page = doc.new_page(width=PAGE_W, height=PAGE_H)

            # Title lines (small caps)
            _draw_small_caps(page, PAGE_W / 2, TITLE_LINE1_Y,
                             f'{year} GYMNASTICS', TITLE1_LARGE, TITLE1_SMALL)
            _draw_small_caps(page, PAGE_W / 2, TITLE_LINE2_Y,
                             f'STATE CHAMPIONS OF {state.upper()}',
                             TITLE2_LARGE, TITLE2_SMALL)

            # Gym name centered below title in red
            _draw_small_caps(page, PAGE_W / 2, gh_gym_name_y,
                             gym_display, gym_name_large, gym_name_small,
                             color=RED)

            # Red oval with group label (shifted down)
            _draw_oval(page, label, gh_oval_y)

            # Column headers with red underlines (shifted down)
            for i, header in enumerate(COL_HEADERS):
                _draw_small_caps(page, COL_CENTERS[i], gh_headers_y,
                                 header, HEADER_LARGE, HEADER_SMALL)
                hw = _measure_small_caps_width(header, HEADER_LARGE, HEADER_SMALL)
                line_y = gh_headers_y + 3
                page.draw_line(fitz.Point(COL_CENTERS[i] - hw / 2, line_y),
                               fitz.Point(COL_CENTERS[i] + hw / 2, line_y),
                               color=RED, width=0.5)

            # Determine best font size (using shifted start position)
            font_size = _fit_font_size(group_levels, data, lhr, lgap, mfill, mfs, mxfs,
                                        names_start_y=gh_names_start)
            line_height = font_size * lhr

            # Draw each level's names with yellow highlighting
            y = gh_names_start
            for level in group_levels:
                y += lgap
                if level in XCEL_MAP:
                    divider_text = XCEL_MAP[level]
                else:
                    divider_text = f'LEVEL {level}'
                _draw_level_divider(page, y, divider_text)
                y += LEVEL_DIVIDER_SIZE * 1.3

                max_names = 0
                for col_idx, event in enumerate(EVENT_KEYS):
                    names = data[event].get(level, [])
                    if names:
                        _draw_names(page, y, col_idx, names, font_size,
                                    line_height, highlight_names=highlight_names)
                        max_names = max(max_names, len(names))
                y += max_names * line_height + 1

            _draw_copyright(page)

    doc.save(output_path)
    doc.close()
