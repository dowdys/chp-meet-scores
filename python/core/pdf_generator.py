"""Enhanced back-of-shirt PDF generator for gymnastics meet results.

Generates championship-style PDFs with:
- Small-caps title and state line
- Red filled oval with level group label
- Small-caps column headers with red underlines
- Red line level dividers with letter-spaced text
- Dynamic font sizing: keeps names as BIG as possible
- Tight line spacing (1.15 ratio) to maximize name size
- Auto-grouping: Xcel levels together, numbered levels bin-packed
- No page should be more than ~90% full
- Copyright footer
"""

import sqlite3
import fitz  # PyMuPDF

# --- Page layout constants (letter: 612 x 792 pt) ---
PAGE_W = 612
PAGE_H = 792

COL_CENTERS = [72, 192, 306, 420, 546]
COL_HEADERS = ['VAULT', 'BARS', 'BEAM', 'FLOOR', 'ALL AROUND']
EVENT_KEYS = ['vault', 'bars', 'beam', 'floor', 'aa']

# Colors
RED = (1, 0, 0)
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)

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
TITLE_LINE1_Y = 35
TITLE_LINE2_Y = 60
OVAL_CENTER_Y = 88
HEADERS_Y = 115
NAMES_START_Y = 132
COPYRIGHT_Y = PAGE_H - 12
NAMES_BOTTOM_Y = PAGE_H - 30

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


def generate_shirt_pdf(db_path: str, meet_name: str, output_path: str,
                       year: str = '2026', state: str = 'Maryland',
                       line_spacing: float = None, level_gap: float = None,
                       max_fill: float = None, min_font_size: float = None,
                       max_font_size: float = None):
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
    """
    # Apply overrides or use module defaults
    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mfs = min_font_size if min_font_size is not None else MIN_NAME_SIZE
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    levels, data = _get_winners_by_event_and_level(db_path, meet_name)
    if not levels:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    # Classify levels into Xcel and numbered
    xcel_levels = []
    numbered_levels = []
    for level in levels:
        if level in XCEL_MAP:
            xcel_levels.append(level)
        else:
            numbered_levels.append(level)

    # Sort Xcel by prestige (Sapphire first)
    xcel_levels.sort(key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                     if XCEL_MAP.get(lv) in XCEL_ORDER else 99)

    # Sort numbered descending (10, 9, 8, ...)
    numbered_levels.sort(key=lambda lv: -int(lv) if lv.isdigit() else 0)

    # Build page groups: (oval_label, [levels])
    page_groups = []

    if xcel_levels:
        page_groups.append(('XCEL', xcel_levels))

    if numbered_levels:
        available = (NAMES_BOTTOM_Y - NAMES_START_Y) * mfill
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

def _get_winners_by_event_and_level(db_path: str, meet_name: str):
    """Get winner names organized by event and level."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute('''SELECT DISTINCT level FROM winners
                   WHERE meet_name = ?''', (meet_name,))
    levels = [row[0] for row in cur.fetchall()]

    data = {}
    for event in EVENT_KEYS:
        data[event] = {}
        for level in levels:
            cur.execute('''SELECT DISTINCT name FROM winners
                          WHERE meet_name = ? AND event = ? AND level = ?
                          ORDER BY name''', (meet_name, event, level))
            names = [row[0] for row in cur.fetchall()]
            if names:
                data[event][level] = names

    conn.close()
    return levels, data


# --- Layout helpers ---

def _bin_pack_levels(levels, data, available_height,
                     line_height_ratio=LINE_HEIGHT_RATIO,
                     level_gap=LEVEL_GAP,
                     max_font_size=DEFAULT_NAME_SIZE):
    """Bin-pack levels into page-sized groups."""
    line_height = max_font_size * line_height_ratio
    pages = []
    current_page = []
    current_height = 0

    for level in levels:
        max_names = max(
            len(data[event].get(level, []))
            for event in EVENT_KEYS
        )
        needed = level_gap + LEVEL_DIVIDER_SIZE * 1.3 + max_names * line_height + 1

        if current_page and current_height + needed > available_height:
            pages.append(current_page)
            current_page = [level]
            current_height = needed
        else:
            current_page.append(level)
            current_height += needed

    if current_page:
        pages.append(current_page)
    return pages


def _fit_font_size(levels, data,
                   line_height_ratio=LINE_HEIGHT_RATIO,
                   level_gap=LEVEL_GAP,
                   max_page_fill=MAX_PAGE_FILL,
                   min_name_size=MIN_NAME_SIZE,
                   max_font_size=DEFAULT_NAME_SIZE):
    """Find the largest font size that fits all levels on page.

    Tries max_font_size down to min_name_size in 0.1 steps.
    Targets max_page_fill fraction of available space.
    """
    available = (NAMES_BOTTOM_Y - NAMES_START_Y) * max_page_fill
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

def _draw_small_caps(page, center_x, y, text, large_size, small_size):
    """Draw text in small caps, centered horizontally.

    First letter of each word at large_size, rest at small_size.
    All characters rendered uppercase.
    """
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
                             fontname=FONT_BOLD, fontsize=fs, color=BLACK)
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
    oval_w = tw + 40
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


def _draw_names(page, y, col_idx, names, font_size, line_height):
    """Draw a centered list of names in the given column."""
    cx = COL_CENTERS[col_idx]
    current_y = y
    for name in names:
        tw = fitz.get_text_length(name, fontname=FONT_REGULAR, fontsize=font_size)
        page.insert_text(fitz.Point(cx - tw / 2, current_y), name,
                         fontname=FONT_REGULAR, fontsize=font_size, color=BLACK)
        current_y += line_height


def _draw_copyright(page):
    """Draw copyright footer at page bottom."""
    text = '\u00a9 C. H. Publishing'
    tw = fitz.get_text_length(text, fontname=FONT_REGULAR, fontsize=COPYRIGHT_SIZE)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, COPYRIGHT_Y), text,
                     fontname=FONT_REGULAR, fontsize=COPYRIGHT_SIZE, color=BLACK)
