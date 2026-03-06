"""Championship t-shirt order form PDF generator.

Generates a professional order form matching the TX Order Form 2025 sample:
- Top half: Marketing flyer with QR code, congratulations, t-shirt graphic,
  product specs, deadlines, and ordering info
- Dashed cut line with scissors icon
- Bottom half: Mailed order form with pre-filled athlete info, size table,
  shipping, and jewel option
- One page per winning athlete, organized by gym
"""

import io
import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

try:
    import qrcode
    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False

from python.core.constants import EVENTS as EVENT_ORDER, EVENT_DISPLAY
from python.core.pdf_generator import (
    _draw_small_caps, _measure_small_caps_width,
    precompute_shirt_data, add_shirt_back_pages
)

# Page layout (letter: 612 x 792 pt)
PAGE_W = 612
PAGE_H = 792
LEFT_MARGIN = 36
RIGHT_MARGIN = PAGE_W - 36
CONTENT_W = RIGHT_MARGIN - LEFT_MARGIN

FONT_REGULAR = 'Times-Roman'
FONT_BOLD = 'Times-Bold'
FONT_ITALIC = 'Times-Italic'
FONT_BOLD_ITALIC = 'Times-BoldItalic'

BLACK = (0, 0, 0)
RED = (0.8, 0, 0)
BLUE = (0, 0, 0.7)
GRAY = (0.4, 0.4, 0.4)
LIGHT_GRAY = (0.7, 0.7, 0.7)
LIGHTER_GRAY = (0.85, 0.85, 0.85)
WHITE = (1, 1, 1)
LIGHT_GREEN = (0.85, 0.95, 0.85)
YELLOW_HIGHLIGHT = (1.0, 1.0, 0.8)

# Shirt sizes and price
SHIRT_SIZES = [
    'Youth Small (6-8)', 'Youth Med. (10-12)', 'Youth Large (14-16)',
    'Adult Small', 'Adult Medium', 'Adult Large', 'Adult X Large', 'Adult XX Large',
]
PRICE_EACH = '$27.95'
SHIPPING_FIRST = '$5.25'
SHIPPING_ADDED = '$2.90'
JEWEL_PRICE = '$4.50'

# Default deadline dates
DEFAULT_POSTMARK = 'TBD'
DEFAULT_ONLINE = 'TBD'
DEFAULT_SHIP = 'TBD'


def generate_order_forms_pdf(db_path: str, meet_name: str, output_path: str,
                             year: str = '2026', state: str = '',
                             postmark_date: str = DEFAULT_POSTMARK,
                             online_date: str = DEFAULT_ONLINE,
                             ship_date: str = DEFAULT_SHIP,
                             line_spacing: float = None,
                             level_gap: float = None,
                             max_fill: float = None,
                             min_font_size: float = None,
                             max_font_size: float = None,
                             name_sort: str = 'age'):
    """Generate per-athlete order form PDF, grouped by gym.

    Each athlete gets an order form page followed by back-of-shirt page(s)
    showing all winners with a red star next to their name.

    Args:
        db_path: Path to SQLite database.
        meet_name: Meet name to filter by.
        output_path: Where to save the PDF.
        year: Championship year for title.
        state: State name for t-shirt graphic.
        postmark_date: Postmark deadline date string.
        online_date: Online ordering deadline date string.
        ship_date: Shipping date string.
        line_spacing: Line height ratio for shirt back pages.
        level_gap: Vertical gap before each level section.
        max_fill: Max page fill fraction.
        min_font_size: Minimum name font size in points.
        max_font_size: Maximum name font size in points.
        name_sort: 'age' or 'alpha' sort order.
    """
    gym_athletes = _get_gym_athletes(db_path, meet_name)
    if not gym_athletes:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    # Extract state from meet_name if not provided
    if not state:
        state = _extract_state(meet_name)

    # Pre-compute shirt data once for all athletes
    shirt_data = precompute_shirt_data(db_path, meet_name,
                                       name_sort=name_sort,
                                       line_spacing=line_spacing,
                                       level_gap=level_gap,
                                       max_fill=max_fill,
                                       min_font_size=min_font_size,
                                       max_font_size=max_font_size)

    doc = fitz.open()
    gyms = sorted(gym_athletes.keys())

    for gi, gym in enumerate(gyms):
        athletes = gym_athletes[gym]
        for athlete_name, level_events in athletes:
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            _draw_order_form(page, athlete_name, gym, level_events, year,
                             state, postmark_date, online_date, ship_date)
            # Append back-of-shirt page(s) with red star next to this athlete
            add_shirt_back_pages(doc, shirt_data, athlete_name, year, state)

    doc.save(output_path)
    doc.close()


def _extract_state(meet_name: str) -> str:
    """Try to extract state name from meet name."""
    # Common patterns like "2025 Texas State Championships"
    parts = meet_name.split()
    for i, part in enumerate(parts):
        if part.lower() == 'state' and i > 0:
            return parts[i - 1]
    return ''


def _get_gym_athletes(db_path: str, meet_name: str):
    """Get winners grouped by gym, then by athlete with events per level."""
    from python.core.division_detector import detect_division_order

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    div_order = detect_division_order(db_path, meet_name)

    cur.execute('''
        SELECT gym, name, level, division, event
        FROM winners
        WHERE meet_name = ?
        ORDER BY gym, name,
                 CAST(level AS INTEGER),
                 CASE event
                     WHEN 'vault' THEN 1 WHEN 'bars' THEN 2
                     WHEN 'beam' THEN 3 WHEN 'floor' THEN 4
                     WHEN 'aa' THEN 5
                 END
    ''', (meet_name,))

    gym_data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    athlete_divisions = {}
    for gym, name, level, division, event in cur.fetchall():
        display = EVENT_DISPLAY.get(event, event)
        if display not in gym_data[gym][name][level]:
            gym_data[gym][name][level].append(display)
        key = (gym, name)
        div_sort = div_order.get(division, 99)
        if key not in athlete_divisions or div_sort < athlete_divisions[key]:
            athlete_divisions[key] = div_sort

    conn.close()

    result = {}
    for gym in gym_data:
        athletes = []
        for name in gym_data[gym]:
            level_events = dict(gym_data[gym][name])
            athletes.append((name, level_events))
        athletes.sort(key=lambda a: (athlete_divisions.get((gym, a[0]), 99), a[0]))
        result[gym] = athletes

    return result


# =============================================================================
# Main draw function
# =============================================================================

def _draw_order_form(page, athlete_name: str, gym: str,
                     level_events: dict, year: str, state: str,
                     postmark_date: str, online_date: str, ship_date: str):
    """Draw a single order form page matching the TX sample layout."""
    # === TOP HALF: Marketing Flyer ===
    y = _draw_top_half(page, year, state, postmark_date, online_date, ship_date)

    # === DASHED CUT LINE ===
    y = _draw_cut_line(page, y, postmark_date, ship_date)

    # === BOTTOM HALF: Order Form ===
    _draw_bottom_half(page, y, athlete_name, gym, level_events)


# =============================================================================
# TOP HALF — Marketing Flyer
# =============================================================================

def _draw_top_half(page, year: str, state: str,
                   postmark_date: str, online_date: str, ship_date: str):
    """Draw the marketing/flyer top half of the page."""
    y = 36

    # --- QR Code (top-right corner) ---
    _draw_qr_code(page)

    # --- "CONGRATULATIONS TO YOUR" ---
    _draw_small_caps(page, PAGE_W / 2, y, 'CONGRATULATIONS TO YOUR', 22, 16,
                     color=BLACK)
    y += 30

    # --- "{year} STATE CHAMPION!" ---
    _draw_small_caps(page, PAGE_W / 2, y, f'{year} STATE CHAMPION!', 30, 22,
                     color=BLACK)
    y += 28

    # --- Subtitle line 1 ---
    # "Your daughter's hard work and gymnastics' skills earned her a"
    sub1 = "Your daughter's hard work and gymnastics' skills earned her a"
    tw1 = fitz.get_text_length(sub1, fontname=FONT_BOLD, fontsize=11)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw1 / 2, y), sub1,
                     fontname=FONT_BOLD, fontsize=11, color=BLACK)
    y += 16

    # "STATE CHAMPIONSHIP TITLE" in small caps + "this season!"
    sc_text = 'STATE CHAMPIONSHIP TITLE'
    sc_width = _measure_small_caps_width(sc_text, 13, 10)
    suffix = ' this season!'
    suffix_w = fitz.get_text_length(suffix, fontname=FONT_BOLD, fontsize=11)
    total_w = sc_width + suffix_w
    start_x = PAGE_W / 2 - total_w / 2
    _draw_small_caps_at(page, start_x, y, sc_text, 13, 10, color=BLACK)
    page.insert_text(fitz.Point(start_x + sc_width, y), suffix,
                     fontname=FONT_BOLD, fontsize=11, color=BLACK)
    y += 18

    # --- "This notable accomplishment..." line ---
    line_a = 'This notable accomplishment is displayed on a '
    sc_b = 'STATE CHAMPIONSHIP T-SHIRT.'
    wa = fitz.get_text_length(line_a, fontname=FONT_REGULAR, fontsize=10)
    wb = _measure_small_caps_width(sc_b, 12, 9)
    total = wa + wb
    sx = PAGE_W / 2 - total / 2
    page.insert_text(fitz.Point(sx, y), line_a,
                     fontname=FONT_REGULAR, fontsize=10, color=BLACK)
    _draw_small_caps_at(page, sx + wa, y, sc_b, 12, 9, color=BLACK)
    y += 18

    # --- Three deadline lines ---
    y = _draw_deadline_lines(page, y, postmark_date, online_date, ship_date)

    # --- Two-column middle section ---
    y = _draw_middle_section(page, y, year, state)

    return y


def _draw_qr_code(page):
    """Draw QR code in top-right corner linking to chpublish.com."""
    if not HAS_QRCODE:
        return

    qr = qrcode.QRCode(version=1, box_size=10, border=1)
    qr.add_data('https://chpublish.com')
    qr.make(fit=True)
    img = qr.make_image(fill_color='black', back_color='white')

    buf = io.BytesIO()
    img.save(buf, format='PNG')
    buf.seek(0)

    qr_size = 65
    x0 = RIGHT_MARGIN - qr_size
    y0 = 30
    rect = fitz.Rect(x0, y0, x0 + qr_size, y0 + qr_size)
    page.insert_image(rect, stream=buf.getvalue())


def _draw_deadline_lines(page, y, postmark_date, online_date, ship_date):
    """Draw the three deadline information lines."""
    fs = 9

    # Line 1: Mailed orders postmark deadline
    parts1 = [
        ('Mailed orders must be ', FONT_REGULAR, BLACK),
        ('postmarked', FONT_ITALIC, BLACK),
        (' on or before ', FONT_REGULAR, BLACK),
        (postmark_date, FONT_BOLD, BLACK),
    ]
    _draw_centered_mixed(page, y, parts1, fs)
    y += 13

    # Line 2: Credit card orders online
    parts2 = [
        ('Credit card orders are available online at ', FONT_REGULAR, BLACK),
        ('chpublish.com', FONT_BOLD, BLACK),
        (' through ', FONT_REGULAR, BLACK),
        (online_date, FONT_BOLD, BLACK),
    ]
    _draw_centered_mixed(page, y, parts2, fs)
    y += 13

    # Line 3: Shipping date
    parts3 = [
        ('T-Shirts will be shipped ', FONT_REGULAR, BLACK),
        ('to your home address', FONT_ITALIC, BLACK),
        (' the week of ', FONT_REGULAR, BLACK),
        (ship_date, FONT_BOLD, BLACK),
        (' or before.', FONT_REGULAR, BLACK),
    ]
    _draw_centered_mixed(page, y, parts3, fs)
    y += 18

    return y


def _draw_middle_section(page, y, year: str, state: str):
    """Draw the two-column middle section with t-shirt graphic and specs."""
    mid_x = PAGE_W / 2
    left_col_x = LEFT_MARGIN + 8
    right_col_x = mid_x + 15

    # === LEFT SIDE ===

    # T-shirt mockup area
    shirt_top = y
    shirt_w = mid_x - LEFT_MARGIN - 20
    shirt_h = 110
    shirt_rect = fitz.Rect(left_col_x, shirt_top,
                           left_col_x + shirt_w, shirt_top + shirt_h)

    # Light green background
    page.draw_rect(shirt_rect, color=BLACK, fill=LIGHT_GREEN, width=0.75)

    # Draw state/year text on t-shirt graphic
    cx = left_col_x + shirt_w / 2
    ty = shirt_top + 18
    _draw_small_caps_at(page, cx - _measure_small_caps_width(state.upper(), 14, 10) / 2,
                        ty, state.upper(), 14, 10, color=RED)
    ty += 20
    _draw_small_caps_at(page, cx - _measure_small_caps_width(year, 14, 10) / 2,
                        ty, year, 14, 10, color=BLUE)
    ty += 20
    _draw_small_caps_at(page, cx - _measure_small_caps_width('GYMNASTICS', 12, 9) / 2,
                        ty, 'GYMNASTICS', 12, 9, color=RED)
    ty += 20
    _draw_small_caps_at(page, cx - _measure_small_caps_width('STATE CHAMPION', 12, 9) / 2,
                        ty, 'STATE CHAMPION', 12, 9, color=BLUE)

    y_after_shirt = shirt_top + shirt_h + 6

    # Red Jewel callout (rotated ~15 degrees)
    _draw_jewel_callout(page, left_col_x + shirt_w - 30, shirt_top + shirt_h - 15)

    # "Front Graphic will have a distressed appearance..." note
    note = 'Front Graphic will have a distressed appearance.'
    page.insert_text(fitz.Point(left_col_x + 4, y_after_shirt),
                     note, fontname=FONT_ITALIC, fontsize=7.5, color=GRAY)
    note2 = 'Note the website photo at chpublish.com.'
    page.insert_text(fitz.Point(left_col_x + 4, y_after_shirt + 9),
                     note2, fontname=FONT_ITALIC, fontsize=7.5, color=GRAY)
    y_after_shirt += 22

    # "State Champion Gymnasts' Names..." block
    block_lines = [
        "State Champion Gymnasts' Names",
        'Under Each Event and All-Around',
        '(See Back)',
    ]
    for line in block_lines:
        tw = fitz.get_text_length(line, fontname=FONT_BOLD, fontsize=8.5)
        page.insert_text(fitz.Point(cx - tw / 2, y_after_shirt), line,
                         fontname=FONT_BOLD, fontsize=8.5, color=BLACK)
        y_after_shirt += 11

    # Disclaimer
    y_after_shirt += 3
    disc = '* The lists of gymnasts on this shirt are noted'
    disc2 = '  on the back of this form...'
    page.insert_text(fitz.Point(left_col_x + 4, y_after_shirt), disc,
                     fontname=FONT_ITALIC, fontsize=7, color=GRAY)
    page.insert_text(fitz.Point(left_col_x + 4, y_after_shirt + 8), disc2,
                     fontname=FONT_ITALIC, fontsize=7, color=GRAY)

    # === RIGHT SIDE ===
    ry = shirt_top

    # Product specs box
    specs_h = 58
    specs_rect = fitz.Rect(right_col_x, ry,
                           RIGHT_MARGIN - 4, ry + specs_h)
    page.draw_rect(specs_rect, color=BLACK, width=0.75)

    spec_y = ry + 12
    spec_cx = (right_col_x + RIGHT_MARGIN - 4) / 2
    spec_lines_sc = [
        'RED AND BLUE SCREEN (OR DTF) PRINTING',
        '100% COTTON',
        'WHITE OR GRAY T-SHIRT',
        'SHORT SLEEVE',
    ]
    for sline in spec_lines_sc:
        sw = _measure_small_caps_width(sline, 9, 7)
        _draw_small_caps_at(page, spec_cx - sw / 2, spec_y, sline, 9, 7,
                            color=BLACK)
        spec_y += 11

    ry += specs_h + 12

    # Send order form to address
    page.insert_text(fitz.Point(right_col_x + 4, ry),
                     'Send order form to:', fontname=FONT_BOLD, fontsize=8.5,
                     color=BLACK)
    ry += 11
    addr_lines = [
        'C. H. Publishing',
        '701 Shamrock Road',
        'High Point, NC 27265',
    ]
    for aline in addr_lines:
        page.insert_text(fitz.Point(right_col_x + 4, ry), aline,
                         fontname=FONT_REGULAR, fontsize=8.5, color=BLACK)
        ry += 11

    ry += 4

    # Questions? Call
    page.insert_text(fitz.Point(right_col_x + 4, ry),
                     'Questions? Call:', fontname=FONT_BOLD, fontsize=8.5,
                     color=BLACK)
    ry += 11
    page.insert_text(fitz.Point(right_col_x + 4, ry),
                     '(336) 886-1984 office', fontname=FONT_REGULAR,
                     fontsize=8.5, color=BLACK)
    ry += 11
    page.insert_text(fitz.Point(right_col_x + 4, ry),
                     '(336) 687-3163 cell', fontname=FONT_REGULAR,
                     fontsize=8.5, color=BLACK)
    ry += 14

    # Checks payable to
    page.insert_text(fitz.Point(right_col_x + 4, ry),
                     'Checks payable to: C. H. Publishing',
                     fontname=FONT_BOLD, fontsize=8.5, color=BLACK)
    ry += 16

    # "Don't forget a shirt for..." box
    forget_rect = fitz.Rect(right_col_x, ry,
                            RIGHT_MARGIN - 4, ry + 30)
    page.draw_rect(forget_rect, color=BLACK, width=0.75)
    forget_text1 = "Don't forget a shirt for Mom, Dad,"
    forget_text2 = 'Grandma, Grandpa, Aunt and Coach!'
    ftw1 = fitz.get_text_length(forget_text1, fontname=FONT_BOLD, fontsize=8)
    ftw2 = fitz.get_text_length(forget_text2, fontname=FONT_BOLD, fontsize=8)
    fcx = (right_col_x + RIGHT_MARGIN - 4) / 2
    page.insert_text(fitz.Point(fcx - ftw1 / 2, ry + 12), forget_text1,
                     fontname=FONT_BOLD, fontsize=8, color=BLACK)
    page.insert_text(fitz.Point(fcx - ftw2 / 2, ry + 23), forget_text2,
                     fontname=FONT_BOLD, fontsize=8, color=BLACK)

    return max(y_after_shirt + 16, ry + 36)


def _draw_jewel_callout(page, x, y):
    """Draw the Red Jewel callout text (rotated ~15 degrees)."""
    import math
    angle = 15  # degrees
    rad = math.radians(angle)

    lines = [
        ('$4.50 per shirt.', FONT_BOLD, 7.5),
        ('One red jewel placed', FONT_REGULAR, 7),
        ("beside the gymnast's", FONT_REGULAR, 7),
        ('name and/or names.', FONT_REGULAR, 7),
        ('See picture at', FONT_REGULAR, 7),
        ('chpublish.com', FONT_BOLD, 7),
    ]

    morph = (fitz.Point(x, y), fitz.Matrix(1, 0, 0, 1, 0, 0).prerotate(-angle))
    cy = y
    for text, font, fs in lines:
        page.insert_text(fitz.Point(x, cy), text,
                         fontname=font, fontsize=fs, color=RED,
                         morph=morph)
        cy += fs + 2


# =============================================================================
# CUT LINE
# =============================================================================

def _draw_cut_line(page, y, postmark_date, ship_date):
    """Draw scissors icon + dashed cut line with integrated title."""
    y += 4

    # Scissors icon
    page.insert_text(fitz.Point(LEFT_MARGIN, y + 3), '\u2702',
                     fontname='helv', fontsize=10, color=BLACK)

    # Dashed line
    dash_start = LEFT_MARGIN + 14
    dash_len = 6
    gap_len = 4
    x = dash_start
    while x < RIGHT_MARGIN:
        end_x = min(x + dash_len, RIGHT_MARGIN)
        page.draw_line(fitz.Point(x, y), fitz.Point(end_x, y),
                       color=BLACK, width=0.75)
        x += dash_len + gap_len

    # Integrated title below cut line
    y += 12
    title_parts = [
        ('MAILED ORDER FORM: POSTMARKED BY ', FONT_BOLD, BLACK),
        (postmark_date, FONT_BOLD, BLACK),
        (' [SHIPPING BY THE WEEK OF ', FONT_REGULAR, BLACK),
        (ship_date, FONT_BOLD, BLACK),
        (' OR BEFORE]', FONT_REGULAR, BLACK),
    ]
    # Draw as small caps centered
    full_text = f'MAILED ORDER FORM: POSTMARKED BY {postmark_date} [SHIPPING BY THE WEEK OF {ship_date} OR BEFORE]'
    tw = fitz.get_text_length(full_text, fontname=FONT_BOLD, fontsize=7.5)
    sx = PAGE_W / 2 - tw / 2
    page.insert_text(fitz.Point(sx, y), full_text,
                     fontname=FONT_BOLD, fontsize=7.5, color=BLACK)

    return y + 12


# =============================================================================
# BOTTOM HALF — Order Form
# =============================================================================

def _draw_bottom_half(page, y, athlete_name: str, gym: str,
                      level_events: dict):
    """Draw the bottom order form half."""
    mid_x = PAGE_W / 2 - 10

    # === LEFT COLUMN: Customer Info ===
    left_x = LEFT_MARGIN + 8
    field_y = y + 4

    # Build level/events string for pre-fill
    level_str_parts = []
    for level in sorted(level_events.keys(),
                        key=lambda lv: int(lv) if lv.isdigit() else 0):
        events_str = ', '.join(level_events[level])
        level_display = f'Level {level}' if level.isdigit() else level
        level_str_parts.append(f'{level_display}: {events_str}')
    level_str = '; '.join(level_str_parts)

    fields = [
        ('Parent Name', ''),
        ('Address', ''),
        ('Address', ''),
        ('Gymnast Name', athlete_name),
        ('Gymnast Club', gym),
        ('Competitive Level', level_str),
        ('Contact Phone #', ''),
        ('Email', ''),
    ]

    for label, prefill in fields:
        page.insert_text(fitz.Point(left_x, field_y), f'{label}:',
                         fontname=FONT_REGULAR, fontsize=8, color=BLACK)
        label_w = fitz.get_text_length(f'{label}: ', fontname=FONT_REGULAR,
                                       fontsize=8)
        if prefill:
            page.insert_text(fitz.Point(left_x + label_w, field_y), prefill,
                             fontname=FONT_BOLD, fontsize=8, color=BLACK)
        else:
            page.draw_line(
                fitz.Point(left_x + label_w, field_y + 2),
                fitz.Point(mid_x - 10, field_y + 2),
                color=LIGHT_GRAY, width=0.5)
        field_y += 14

    # Footer box: "For online ordering..."
    field_y += 6
    footer_rect = fitz.Rect(left_x, field_y, mid_x - 10, field_y + 22)
    page.draw_rect(footer_rect, color=BLACK, width=0.5)
    footer1 = 'For online ordering or more information'
    footer2 = 'go to chpublish.com'
    fw1 = fitz.get_text_length(footer1, fontname=FONT_REGULAR, fontsize=8)
    fw2 = fitz.get_text_length(footer2, fontname=FONT_BOLD, fontsize=8)
    fcx = (left_x + mid_x - 10) / 2
    page.insert_text(fitz.Point(fcx - fw1 / 2, field_y + 10), footer1,
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    page.insert_text(fitz.Point(fcx - fw2 / 2, field_y + 20), footer2,
                     fontname=FONT_BOLD, fontsize=8, color=BLACK)

    # === RIGHT COLUMN: Order Table ===
    _draw_order_table(page, y, mid_x)


def _draw_order_table(page, y, table_left_x):
    """Draw the order table with sizes, jewel option, and totals."""
    col_qty = table_left_x + 4
    col_size = table_left_x + 40
    col_option = table_left_x + 150
    col_price = RIGHT_MARGIN - 100
    col_total = RIGHT_MARGIN - 40

    ty = y + 2

    # Table headers
    headers = [
        (col_qty, 'Qty'),
        (col_size, 'Size'),
        (col_option, 'Circle J For\nJeweled Option'),
        (col_total, 'Total'),
    ]
    page.insert_text(fitz.Point(col_qty, ty), 'Qty',
                     fontname=FONT_BOLD, fontsize=7, color=BLACK)
    page.insert_text(fitz.Point(col_size, ty), 'Size',
                     fontname=FONT_BOLD, fontsize=7, color=BLACK)
    page.insert_text(fitz.Point(col_option, ty), 'Circle J For',
                     fontname=FONT_BOLD, fontsize=6.5, color=BLACK)
    page.insert_text(fitz.Point(col_option, ty + 8), 'Jeweled Option',
                     fontname=FONT_BOLD, fontsize=6.5, color=BLACK)
    page.insert_text(fitz.Point(col_price, ty), f'({PRICE_EACH})',
                     fontname=FONT_REGULAR, fontsize=7, color=BLACK)
    page.insert_text(fitz.Point(col_total, ty), 'Total',
                     fontname=FONT_BOLD, fontsize=7, color=BLACK)

    ty += 16

    # Header underline
    page.draw_line(fitz.Point(col_qty, ty), fitz.Point(RIGHT_MARGIN - 4, ty),
                   color=BLACK, width=0.75)
    ty += 4

    # Sample row (yellow highlight)
    sample_h = 14
    sample_rect = fitz.Rect(col_qty - 2, ty - 2,
                            RIGHT_MARGIN - 2, ty + sample_h - 4)
    page.draw_rect(sample_rect, fill=YELLOW_HIGHLIGHT)
    page.insert_text(fitz.Point(col_qty, ty + 6), '1',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(col_size, ty + 6), 'Youth Large (14-16)',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(col_option, ty + 6), '1 White J',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(col_price, ty + 6), f'x {PRICE_EACH}',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(col_total, ty + 6), '$ 32.45',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)

    # "Add Jewel J cost..." label
    page.insert_text(fitz.Point(col_option + 65, ty + 6),
                     f'Add Jewel J cost {JEWEL_PRICE}/Shirt below',
                     fontname=FONT_ITALIC, fontsize=5.5, color=RED)

    ty += sample_h + 2

    # Size rows
    for size in SHIRT_SIZES:
        # Qty blank
        page.draw_line(fitz.Point(col_qty, ty + 8),
                       fitz.Point(col_qty + 22, ty + 8),
                       color=LIGHT_GRAY, width=0.5)
        # Size label
        page.insert_text(fitz.Point(col_size, ty + 6), size,
                         fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
        # White/Gray J option
        page.insert_text(fitz.Point(col_option, ty + 6), '__Wht J / __Gry J',
                         fontname=FONT_REGULAR, fontsize=7, color=BLACK)
        # Price
        page.insert_text(fitz.Point(col_price, ty + 6), f'x {PRICE_EACH}',
                         fontname=FONT_REGULAR, fontsize=7, color=BLACK)
        # Total blank
        page.insert_text(fitz.Point(col_total, ty + 6), '$',
                         fontname=FONT_REGULAR, fontsize=7, color=BLACK)
        page.draw_line(fitz.Point(col_total + 7, ty + 8),
                       fitz.Point(RIGHT_MARGIN - 6, ty + 8),
                       color=LIGHT_GRAY, width=0.5)
        ty += 14

    ty += 6

    # === Totals section ===
    label_x = col_price - 90
    amount_x = col_total

    # Shirt Sub Total
    page.insert_text(fitz.Point(label_x, ty), 'Shirt Sub Total',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(amount_x, ty), '$ _______',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    ty += 12

    # First Shirt S&H
    page.insert_text(fitz.Point(label_x, ty), 'First Shirt Shipping & Handling',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(amount_x, ty), f'  {SHIPPING_FIRST}',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    ty += 12

    # Added shirts S&H
    page.insert_text(fitz.Point(label_x, ty),
                     f'Added Shirts S&H _____ x {SHIPPING_ADDED}',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    page.insert_text(fitz.Point(amount_x, ty), '$ _______',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    ty += 12

    # Red Jewel
    page.insert_text(fitz.Point(label_x, ty),
                     f'Red Jewel ({JEWEL_PRICE}/Shirt)',
                     fontname=FONT_REGULAR, fontsize=7.5, color=RED)
    page.insert_text(fitz.Point(amount_x, ty), '$ _______',
                     fontname=FONT_REGULAR, fontsize=7.5, color=BLACK)
    ty += 14

    # Total line (bold, with line above)
    page.draw_line(fitz.Point(label_x, ty - 2),
                   fitz.Point(RIGHT_MARGIN - 4, ty - 2),
                   color=BLACK, width=0.75)
    page.insert_text(fitz.Point(label_x, ty + 6), 'Total Amount Enclosed',
                     fontname=FONT_BOLD, fontsize=9, color=BLACK)
    page.insert_text(fitz.Point(amount_x, ty + 6), '$ _______',
                     fontname=FONT_BOLD, fontsize=9, color=BLACK)


# =============================================================================
# Drawing Helpers
# =============================================================================

def _draw_centered_mixed(page, y, parts, fontsize):
    """Draw centered text with mixed fonts/colors.

    parts: list of (text, fontname, color) tuples.
    """
    total_w = sum(
        fitz.get_text_length(text, fontname=font, fontsize=fontsize)
        for text, font, color in parts
    )
    x = PAGE_W / 2 - total_w / 2
    for text, font, color in parts:
        page.insert_text(fitz.Point(x, y), text,
                         fontname=font, fontsize=fontsize, color=color)
        x += fitz.get_text_length(text, fontname=font, fontsize=fontsize)


def _draw_small_caps_at(page, x, y, text, large_size, small_size,
                        color=None):
    """Draw small caps text starting at position x (not centered).

    Reuses the logic from pdf_generator but without centering.
    """
    if color is None:
        color = BLACK
    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            space_w = fitz.get_text_length(' ', fontname=FONT_BOLD,
                                           fontsize=large_size)
            x += space_w
        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            page.insert_text(fitz.Point(x, y), ch_upper,
                             fontname=FONT_BOLD, fontsize=fs, color=color)
            x += fitz.get_text_length(ch_upper, fontname=FONT_BOLD, fontsize=fs)
