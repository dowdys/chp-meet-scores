"""Championship t-shirt order form PDF generator.

Generates a marketing-style order form inspired by the professional TX Order Form:
- Bold "CONGRATULATIONS" headline with decorative styling
- Product description with details (screen printing, 100% cotton, etc.)
- Ordering deadlines and website info
- Dashed cut line separator
- Detailed mailed order form with sizes, jewel option, and shipping
- One page per winning athlete, organized by gym
"""

import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

# Page layout (letter: 612 x 792 pt)
PAGE_W = 612
PAGE_H = 792
LEFT_MARGIN = 48
RIGHT_MARGIN = PAGE_W - 48
CONTENT_W = RIGHT_MARGIN - LEFT_MARGIN

EVENT_DISPLAY = {
    'vault': 'Vault', 'bars': 'Bars', 'beam': 'Beam',
    'floor': 'Floor', 'aa': 'All Around',
}
EVENT_ORDER = ['vault', 'bars', 'beam', 'floor', 'aa']

FONT_REGULAR = 'Times-Roman'
FONT_BOLD = 'Times-Bold'
FONT_ITALIC = 'Times-Italic'
FONT_BOLD_ITALIC = 'Times-BoldItalic'

BLACK = (0, 0, 0)
RED = (0.8, 0, 0)
GRAY = (0.4, 0.4, 0.4)
LIGHT_GRAY = (0.7, 0.7, 0.7)
WHITE = (1, 1, 1)

# Shirt sizes and price
SHIRT_SIZES = [
    'Youth Small', 'Youth Med.', 'Youth Large',
    'Adult Small', 'Adult Medium', 'Adult Large', 'Adult X Large', 'Adult XX Large',
]
PRICE_EACH = '$27.45'
SHIPPING_FIRST = '$5.25'
SHIPPING_ADDED = '$2.90'
JEWEL_PRICE = '$4.25'


def generate_order_forms_pdf(db_path: str, meet_name: str, output_path: str,
                             year: str = '2026'):
    """Generate per-athlete order form PDF, grouped by gym.

    Args:
        db_path: Path to SQLite database.
        meet_name: Meet name to filter by.
        output_path: Where to save the PDF.
        year: Championship year for title.
    """
    gym_athletes = _get_gym_athletes(db_path, meet_name)
    if not gym_athletes:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    doc = fitz.open()
    gyms = sorted(gym_athletes.keys())

    for gi, gym in enumerate(gyms):
        athletes = gym_athletes[gym]
        for athlete_name, level_events in athletes:
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            _draw_order_form(page, athlete_name, gym, level_events, year)

        # Blank separator page between gyms (not after last)
        if gi < len(gyms) - 1:
            doc.new_page(width=PAGE_W, height=PAGE_H)

    doc.save(output_path)
    doc.close()


def _get_gym_athletes(db_path: str, meet_name: str):
    """Get winners grouped by gym, then by athlete with events per level."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute('''
        SELECT gym, name, level, event
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
    for gym, name, level, event in cur.fetchall():
        display = EVENT_DISPLAY.get(event, event)
        if display not in gym_data[gym][name][level]:
            gym_data[gym][name][level].append(display)

    conn.close()

    result = {}
    for gym in gym_data:
        athletes = []
        for name in sorted(gym_data[gym].keys()):
            level_events = dict(gym_data[gym][name])
            athletes.append((name, level_events))
        result[gym] = athletes

    return result


def _draw_order_form(page, athlete_name: str, gym: str,
                     level_events: dict, year: str):
    """Draw a single marketing-style order form for one athlete."""
    y = 42

    # === TOP SECTION: Congratulations + Product Info ===

    # Big headline: "CONGRATULATIONS TO YOUR"
    y = _center_bold(page, y, 'CONGRATULATIONS TO YOUR', 14, BLACK)
    y += 20

    # Even bigger: "20XX STATE CHAMPION!"
    y = _center_bold(page, y, f'{year} STATE CHAMPION!', 20, BLACK)
    y += 16

    # Emotional subtitle in red italic
    subtitle = "Your gymnast's hard work earned her a State Championship Title!"
    tw = fitz.get_text_length(subtitle, fontname=FONT_ITALIC, fontsize=10)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, y), subtitle,
                     fontname=FONT_ITALIC, fontsize=10, color=RED)
    y += 18

    # Red separator line
    page.draw_line(fitz.Point(LEFT_MARGIN + 20, y), fitz.Point(RIGHT_MARGIN - 20, y),
                   color=RED, width=1.0)
    y += 16

    # --- Athlete Info (centered, prominent) ---
    y = _center_bold(page, y, athlete_name, 16, BLACK)
    y += 18
    y = _center_text(page, y, gym, FONT_REGULAR, 12, BLACK)
    y += 16

    # Events by level
    for level in sorted(level_events.keys(),
                        key=lambda lv: int(lv) if lv.isdigit() else 0):
        events_str = ', '.join(level_events[level])
        level_display = f'Level {level}' if level.isdigit() else level
        line = f'{level_display}: {events_str}'
        y = _center_text(page, y, line, FONT_BOLD, 10, BLACK)
        y += 14

    y += 6

    # Red separator line
    page.draw_line(fitz.Point(LEFT_MARGIN + 20, y), fitz.Point(RIGHT_MARGIN - 20, y),
                   color=RED, width=1.0)
    y += 14

    # --- Product Description (two columns) ---
    left_x = LEFT_MARGIN + 12
    right_box_x = PAGE_W / 2 + 20

    # Left: description text
    desc_lines = [
        'State Champion Gymnasts\' Names',
        'Under Each Event and All-Around',
        '',
        'Only the names of first place gymnasts',
        'are listed. Multiple names reflect different',
        'age categories and first place ties.',
    ]
    desc_y = y
    for line in desc_lines:
        if line:
            page.insert_text(fitz.Point(left_x, desc_y), line,
                             fontname=FONT_REGULAR, fontsize=9, color=BLACK)
        desc_y += 11

    # Right: product specs box
    specs_top = y - 4
    specs_height = 68
    specs_rect = fitz.Rect(right_box_x, specs_top, RIGHT_MARGIN - 8, specs_top + specs_height)
    page.draw_rect(specs_rect, color=RED, width=0.75)

    spec_lines = [
        ('Red and Blue Screen Printing', FONT_BOLD, 9),
        ('100% Cotton \u2022 White or Gray T-Shirt', FONT_REGULAR, 8.5),
        ('Short Sleeve', FONT_REGULAR, 8.5),
        ('', None, 4),
        ("Don't forget a shirt for Mom, Dad,", FONT_BOLD_ITALIC, 8),
        ('Grandma, Grandpa, Aunt and Coach!', FONT_BOLD_ITALIC, 8),
    ]
    spec_y = specs_top + 14
    for text, font, size in spec_lines:
        if text and font:
            page.insert_text(fitz.Point(right_box_x + 8, spec_y), text,
                             fontname=font, fontsize=size, color=BLACK)
        spec_y += size + 3

    y = max(desc_y, specs_top + specs_height) + 10

    # --- Ordering info ---
    page.insert_text(fitz.Point(left_x, y),
                     'Credit card orders available online at ',
                     fontname=FONT_REGULAR, fontsize=9, color=BLACK)
    site_x = left_x + fitz.get_text_length('Credit card orders available online at ', fontname=FONT_REGULAR, fontsize=9)
    page.insert_text(fitz.Point(site_x, y), 'chpublish.com',
                     fontname=FONT_BOLD, fontsize=9, color=RED)
    y += 13

    page.insert_text(fitz.Point(left_x, y),
                     'Send mailed orders to: C. H. Publishing, 701 Shamrock Road, High Point, NC 27265',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 11
    page.insert_text(fitz.Point(left_x, y),
                     'Questions? Call: (336) 886-1984 office  \u2022  (336) 687-3163 cell',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 16

    # === DASHED CUT LINE ===
    _draw_dashed_line(page, y)
    y += 14

    # === BOTTOM SECTION: Mailed Order Form ===
    y = _center_bold(page, y, 'MAILED ORDER FORM', 11, BLACK)
    y += 5
    page.insert_text(fitz.Point(LEFT_MARGIN + 8, y),
                     'Checks payable to: C. H. Publishing',
                     fontname=FONT_BOLD, fontsize=8, color=BLACK)
    y += 16

    # Customer info fields (left column)
    fields_x = LEFT_MARGIN + 8
    field_labels = ['Parent Name', 'Address', 'Gymnast Name', 'Gymnast Club',
                    'Competitive Level', 'Contact Phone #', 'Email']
    for label in field_labels:
        page.insert_text(fitz.Point(fields_x, y), f'{label}:',
                         fontname=FONT_REGULAR, fontsize=8, color=BLACK)
        label_w = fitz.get_text_length(f'{label}: ', fontname=FONT_REGULAR, fontsize=8)
        page.draw_line(fitz.Point(fields_x + label_w, y + 2),
                       fitz.Point(fields_x + 200, y + 2),
                       color=LIGHT_GRAY, width=0.5)
        y += 13

    y += 4

    # --- Order Table ---
    y = _draw_order_table(page, y)


def _draw_order_table(page, y):
    """Draw the detailed order table with sizes, jewel option, and totals."""
    col_qty_x = LEFT_MARGIN + 8
    col_size_x = LEFT_MARGIN + 60
    col_option_x = LEFT_MARGIN + 210
    col_price_x = RIGHT_MARGIN - 130
    col_total_x = RIGHT_MARGIN - 50

    # Table header
    headers = [
        (col_qty_x, '# of Shirts'),
        (col_size_x, 'Size'),
        (col_option_x, 'Circle J For Jeweled Option'),
        (col_total_x, 'Total'),
    ]
    for x, text in headers:
        page.insert_text(fitz.Point(x, y), text,
                         fontname=FONT_BOLD, fontsize=8, color=BLACK)
    y += 4

    # Header underline
    page.draw_line(fitz.Point(col_qty_x, y), fitz.Point(RIGHT_MARGIN - 8, y),
                   color=BLACK, width=0.75)
    y += 12

    # Size rows
    for size in SHIRT_SIZES:
        # Qty blank
        page.draw_line(fitz.Point(col_qty_x, y + 2),
                       fitz.Point(col_qty_x + 40, y + 2),
                       color=LIGHT_GRAY, width=0.5)
        # Size label
        page.insert_text(fitz.Point(col_size_x, y), size,
                         fontname=FONT_REGULAR, fontsize=8.5, color=BLACK)
        # White J / Gray J option
        page.insert_text(fitz.Point(col_option_x, y), '__White J  /  __Gray J',
                         fontname=FONT_REGULAR, fontsize=8, color=BLACK)
        # Price
        page.insert_text(fitz.Point(col_price_x, y), f'x  {PRICE_EACH}',
                         fontname=FONT_REGULAR, fontsize=8, color=BLACK)
        # Total blank
        page.insert_text(fitz.Point(col_total_x, y), '$',
                         fontname=FONT_REGULAR, fontsize=8, color=BLACK)
        page.draw_line(fitz.Point(col_total_x + 8, y + 2),
                       fitz.Point(RIGHT_MARGIN - 8, y + 2),
                       color=LIGHT_GRAY, width=0.5)
        y += 14

    y += 6

    # Totals section
    totals_x = col_price_x - 100
    label_x = totals_x
    amount_x = col_total_x

    # Shirt Sub Total
    page.insert_text(fitz.Point(label_x, y), 'Shirt Sub Total',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    page.insert_text(fitz.Point(amount_x, y), '$ _______',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 13

    # First Shirt S&H
    page.insert_text(fitz.Point(label_x, y), f'First Shirt Shipping & Handling',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    page.insert_text(fitz.Point(amount_x, y), f'  {SHIPPING_FIRST}',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 13

    # Added shirts S&H
    page.insert_text(fitz.Point(label_x, y), f'Added Shirts S&H _____ x {SHIPPING_ADDED}',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    page.insert_text(fitz.Point(amount_x, y), '$ _______',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 13

    # Red Jewel
    page.insert_text(fitz.Point(label_x, y),
                     f'Red Jewel By Daughter\'s Name(s) x {JEWEL_PRICE}/Shirt',
                     fontname=FONT_REGULAR, fontsize=8, color=RED)
    page.insert_text(fitz.Point(amount_x, y), '$ _______',
                     fontname=FONT_REGULAR, fontsize=8, color=BLACK)
    y += 16

    # Total line (bold, larger)
    page.draw_line(fitz.Point(label_x, y - 3), fitz.Point(RIGHT_MARGIN - 8, y - 3),
                   color=BLACK, width=0.75)
    page.insert_text(fitz.Point(label_x, y + 2), 'Total Amount Enclosed',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    page.insert_text(fitz.Point(amount_x, y + 2), '$ _______',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)

    return y + 20


def _draw_dashed_line(page, y):
    """Draw a dashed cut line across the page."""
    dash_len = 6
    gap_len = 4
    x = LEFT_MARGIN
    while x < RIGHT_MARGIN:
        end_x = min(x + dash_len, RIGHT_MARGIN)
        page.draw_line(fitz.Point(x, y), fitz.Point(end_x, y),
                       color=GRAY, width=0.5)
        x += dash_len + gap_len


def _center_bold(page, y, text, fontsize, color):
    """Draw centered bold text."""
    tw = fitz.get_text_length(text, fontname=FONT_BOLD, fontsize=fontsize)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, y), text,
                     fontname=FONT_BOLD, fontsize=fontsize, color=color)
    return y


def _center_text(page, y, text, fontname, fontsize, color):
    """Draw centered text and return y unchanged."""
    tw = fitz.get_text_length(text, fontname=fontname, fontsize=fontsize)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, y), text,
                     fontname=fontname, fontsize=fontsize, color=color)
    return y
