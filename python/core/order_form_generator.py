"""Personalized order form PDF generator for gymnastics meet results.

Generates one PDF page per winning athlete, organized by gym with
blank separator pages between gyms.
"""

import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

# Page layout (letter: 612 x 792 pt)
PAGE_W = 612
PAGE_H = 792
LEFT_MARGIN = 54
RIGHT_MARGIN = PAGE_W - 54
CONTENT_W = RIGHT_MARGIN - LEFT_MARGIN

EVENT_DISPLAY = {
    'vault': 'Vault', 'bars': 'Bars', 'beam': 'Beam',
    'floor': 'Floor', 'aa': 'All Around',
}
EVENT_ORDER = ['vault', 'bars', 'beam', 'floor', 'aa']

FONT_REGULAR = 'Times-Roman'
FONT_BOLD = 'Times-Bold'
BLACK = (0, 0, 0)
GRAY = (0.4, 0.4, 0.4)

# Shirt sizes and price
SHIRT_SIZES = [
    'Youth S', 'Youth M', 'Youth L',
    'Adult S', 'Adult M', 'Adult L', 'Adult XL', 'Adult XXL',
]
PRICE = '$27.45'


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
    """Get winners grouped by gym, then by athlete with events per level.

    Returns:
        dict: {gym_name: [(athlete_name, {level: [event_display, ...]}), ...]}
    """
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

    # Build nested structure: gym -> athlete -> level -> events
    gym_data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    for gym, name, level, event in cur.fetchall():
        display = EVENT_DISPLAY.get(event, event)
        if display not in gym_data[gym][name][level]:
            gym_data[gym][name][level].append(display)

    conn.close()

    # Convert to sorted list format
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
    """Draw a single order form page for one athlete."""
    y = 60

    # --- Title ---
    y = _center_text(page, y, f'CONGRATULATIONS TO YOUR {year} STATE CHAMPION!',
                     FONT_BOLD, 16, BLACK)
    y += 24

    # --- Subtitle ---
    y = _center_text(page, y,
                     'Your gymnast has achieved the highest honor in the state',
                     FONT_REGULAR, 10, GRAY)
    y += 13
    y = _center_text(page, y,
                     'by winning a State Championship event!',
                     FONT_REGULAR, 10, GRAY)
    y += 20

    # --- Separator ---
    y = _draw_separator(page, y)
    y += 20

    # --- Athlete info ---
    y = _center_text(page, y, athlete_name, FONT_BOLD, 14, BLACK)
    y += 18
    y = _center_text(page, y, gym, FONT_REGULAR, 12, BLACK)
    y += 18

    # Events by level
    for level in sorted(level_events.keys(),
                        key=lambda lv: int(lv) if lv.isdigit() else 0):
        events_str = ', '.join(level_events[level])
        # Format level display
        level_display = f'Level {level}' if level.isdigit() else level
        line = f'{level_display}: {events_str}'
        y = _center_text(page, y, line, FONT_REGULAR, 11, BLACK)
        y += 15

    y += 10

    # --- Separator ---
    y = _draw_separator(page, y)
    y += 20

    # --- T-shirt info ---
    y = _center_text(page, y,
                     'To celebrate this accomplishment, a championship t-shirt is available',
                     FONT_REGULAR, 10, BLACK)
    y += 13
    y = _center_text(page, y,
                     'featuring your gymnast\'s name on the back!',
                     FONT_REGULAR, 10, BLACK)
    y += 13
    y = _center_text(page, y,
                     'The shirt lists all State Champions by event and level.',
                     FONT_REGULAR, 10, BLACK)
    y += 25

    # --- Separator ---
    y = _draw_separator(page, y)
    y += 20

    # --- Contact / ordering box ---
    box_top = y
    box_height = 90
    box_rect = fitz.Rect(LEFT_MARGIN, box_top,
                         RIGHT_MARGIN, box_top + box_height)
    page.draw_rect(box_rect, color=BLACK, width=0.5)

    bx = LEFT_MARGIN + 12
    by = box_top + 18
    page.insert_text(fitz.Point(bx, by), 'Order from:',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    by += 15
    page.insert_text(fitz.Point(bx, by), 'C. H. Publishing',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    by += 13
    page.insert_text(fitz.Point(bx, by), 'PO Box 341  \u2022  Bel Air, MD 21014',
                     fontname=FONT_REGULAR, fontsize=9, color=BLACK)
    by += 13
    page.insert_text(fitz.Point(bx, by), 'Phone: (410) 879-8082',
                     fontname=FONT_REGULAR, fontsize=9, color=BLACK)
    by += 15
    page.insert_text(fitz.Point(bx, by),
                     'Make checks payable to: C.H. Publishing',
                     fontname=FONT_BOLD, fontsize=9, color=BLACK)

    y = box_top + box_height + 25

    # --- Order table ---
    y = _draw_order_table(page, y)


def _draw_order_table(page, y):
    """Draw the shirt size / qty / price order table."""
    col_size_x = LEFT_MARGIN + 20
    col_qty_x = LEFT_MARGIN + 200
    col_price_x = LEFT_MARGIN + 340

    # Table header
    page.insert_text(fitz.Point(col_size_x, y), 'Size',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    page.insert_text(fitz.Point(col_qty_x, y), 'Qty',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    page.insert_text(fitz.Point(col_price_x, y), 'Price Each',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    y += 5

    # Header underline
    page.draw_line(fitz.Point(col_size_x, y),
                   fitz.Point(col_price_x + 80, y),
                   color=BLACK, width=0.5)
    y += 15

    # Size rows
    for size in SHIRT_SIZES:
        page.insert_text(fitz.Point(col_size_x, y), size,
                         fontname=FONT_REGULAR, fontsize=10, color=BLACK)
        # Qty blank line
        page.draw_line(fitz.Point(col_qty_x, y + 2),
                       fitz.Point(col_qty_x + 60, y + 2),
                       color=GRAY, width=0.5)
        page.insert_text(fitz.Point(col_price_x, y), PRICE,
                         fontname=FONT_REGULAR, fontsize=10, color=BLACK)
        y += 18

    y += 10

    # Total line
    page.insert_text(fitz.Point(col_qty_x - 50, y), 'Total:',
                     fontname=FONT_BOLD, fontsize=10, color=BLACK)
    page.draw_line(fitz.Point(col_qty_x, y + 2),
                   fitz.Point(col_qty_x + 60, y + 2),
                   color=BLACK, width=0.5)

    return y + 20


def _center_text(page, y, text, fontname, fontsize, color):
    """Draw centered text and return y unchanged (caller manages y)."""
    tw = fitz.get_text_length(text, fontname=fontname, fontsize=fontsize)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, y), text,
                     fontname=fontname, fontsize=fontsize, color=color)
    return y


def _draw_separator(page, y):
    """Draw a horizontal rule separator."""
    page.draw_line(fitz.Point(LEFT_MARGIN + 40, y),
                   fitz.Point(RIGHT_MARGIN - 40, y),
                   color=GRAY, width=0.5)
    return y
