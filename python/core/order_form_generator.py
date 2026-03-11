"""Order form PDF generator using template overlay.

Uses the TX Order Form 2025 PDF as a base template. For each athlete,
copies the template page, whites out variable fields, and fills in
dynamic values (year, state, dates, athlete sticker label).
"""

import os
import sys
import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

from python.core.constants import EVENTS as EVENT_ORDER, EVENT_DISPLAY
from python.core.pdf_generator import (
    _draw_small_caps, _measure_small_caps_width,
    precompute_shirt_data, add_shirt_back_pages
)

PAGE_W = 612
PAGE_H = 792
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)
RED = (0.8, 0, 0)
FONT_BOLD = 'Times-Bold'
FONT_REGULAR = 'Times-Roman'

# PyInstaller extracts --add-data files relative to sys._MEIPASS;
# in dev/system-Python mode, resolve relative to this source file.
_BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(_BASE_DIR, 'templates')
TEMPLATE_PDF = os.path.join(TEMPLATE_DIR, 'order_form_template.pdf')

# Event display order for sticker label
STICKER_EVENT_ORDER = ['Vault', 'Bars', 'Beam', 'Floor', 'AA']


def generate_order_forms_pdf(db_path: str, meet_name: str, output_path: str,
                             year: str = '2026', state: str = '',
                             postmark_date: str = 'TBD',
                             online_date: str = 'TBD',
                             ship_date: str = 'TBD',
                             line_spacing: float = None,
                             level_gap: float = None,
                             max_fill: float = None,
                             min_font_size: float = None,
                             max_font_size: float = None,
                             name_sort: str = 'age',
                             max_shirt_pages: int = None,
                             title1_size: float = None,
                             title2_size: float = None,
                             level_groups: str = None):
    """Generate per-athlete order form PDF using the template overlay approach.

    Each athlete gets an order form page (template with filled-in variables)
    followed by back-of-shirt page(s) with a red star next to their name.
    """
    gym_athletes = _get_gym_athletes(db_path, meet_name)
    if not gym_athletes:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    if not state:
        state = _extract_state(meet_name)

    # Pre-compute shirt data for back pages
    shirt_data = precompute_shirt_data(db_path, meet_name,
                                       name_sort=name_sort,
                                       line_spacing=line_spacing,
                                       level_gap=level_gap,
                                       max_fill=max_fill,
                                       min_font_size=min_font_size,
                                       max_font_size=max_font_size,
                                       max_shirt_pages=max_shirt_pages,
                                       title1_size=title1_size,
                                       title2_size=title2_size,
                                       level_groups=level_groups)

    if not os.path.exists(TEMPLATE_PDF):
        raise FileNotFoundError(
            f"Order form template not found at {TEMPLATE_PDF}. "
            "Place the template PDF in python/core/templates/")

    template_doc = fitz.open(TEMPLATE_PDF)
    doc = fitz.open()
    gyms = sorted(gym_athletes.keys())

    for gym in gyms:
        athletes = gym_athletes[gym]
        for athlete_name, level_events in athletes:
            # Copy template page
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            page.show_pdf_page(page.rect, template_doc, 0)

            # White out and fill variable fields
            _fill_variables(page, year, state, postmark_date, online_date,
                            ship_date, athlete_name, gym, level_events)

            # Append back-of-shirt page(s) with red star
            add_shirt_back_pages(doc, shirt_data, athlete_name, year, state)

    template_doc.close()
    doc.save(output_path)
    doc.close()


def _white_out(page, rect_coords):
    """Draw a white filled rectangle to cover existing text."""
    rect = fitz.Rect(*rect_coords)
    page.draw_rect(rect, fill=WHITE, color=WHITE, width=0)


def _fill_variables(page, year, state, postmark_date, online_date,
                    ship_date, athlete_name, gym, level_events):
    """White out template variables and insert new values."""

    # === Year in title ("2025" portion of "2025 State Champion!") ===
    # Span "2025 S" bbox [137.3, 37.1, 238.3, 85.1] — cover only "2025"
    _white_out(page, (136, 38, 211, 82))
    page.insert_text(fitz.Point(137, 74), year,
                     fontname=FONT_BOLD, fontsize=36, color=BLACK)

    # === State below scissors ("NorCal" → state) ===
    # bbox [42.0, 491.2, 71.4, 504.4]
    _white_out(page, (41, 490, 73, 505))
    page.insert_text(fitz.Point(42, 501), state,
                     fontname=FONT_REGULAR, fontsize=10, color=BLACK)

    # === State in t-shirt graphic ("Texas" embedded in image) ===
    # Image at bbox [57, 311, 132, 374] — state name in upper portion
    _white_out(page, (58, 314, 131, 330))
    # Insert state name centered in the whiteout area
    state_upper = state.upper()
    sw = fitz.get_text_length(state_upper, fontname=FONT_BOLD, fontsize=10)
    state_cx = (58 + 131) / 2
    page.insert_text(fitz.Point(state_cx - sw / 2, 326),
                     state_upper, fontname=FONT_BOLD, fontsize=10, color=RED)

    # === Deadline dates in body text ===

    # Postmark: "January 17, 2026" bbox [370.2, 210.9, 454.8, 229.6]
    _white_out(page, (369, 210, 456, 230))
    page.insert_text(fitz.Point(370, 225), postmark_date,
                     fontname=FONT_BOLD, fontsize=12.5, color=BLACK)

    # Online: "January 21" + ", 2026" bbox [421.9, 227.7 → 503.7, 246.4]
    _white_out(page, (421, 227, 504, 247))
    page.insert_text(fitz.Point(422, 242), online_date,
                     fontname=FONT_BOLD, fontsize=12.5, color=BLACK)

    # Ship: "February 9, 2026" bbox [373.8, 244.5, 455.6, 263.2]
    _white_out(page, (373, 244, 456, 264))
    page.insert_text(fitz.Point(374, 259), ship_date,
                     fontname=FONT_BOLD, fontsize=12.5, color=BLACK)

    # === Dates in cut line title ===

    # Postmark "January 17" spans [322.3, 488.1 → 398.0, 512.1]
    _white_out(page, (322, 488, 398, 513))
    page.insert_text(fitz.Point(323, 507), postmark_date,
                     fontname=FONT_BOLD, fontsize=11, color=BLACK)

    # Ship "Feb. 9" spans [489.2, 495.5 → 515.2, 509.9]
    _white_out(page, (488, 495, 516, 510))
    page.insert_text(fitz.Point(489, 507), ship_date,
                     fontname=FONT_BOLD, fontsize=7, color=BLACK)

    # === Remove SAMPLE watermark ===
    # bbox [384.6, 536.8, 461.6, 550.1]
    _white_out(page, (383, 536, 463, 551))

    # === Athlete sticker label in blank area near top ===
    # Blank area between subtitle (y≈122) and accomplishment line (y≈173)
    # Jewel callout occupies x<130 on left, so center in full page width

    # Collect all events across all levels (deduplicated, ordered)
    all_events = []
    for level in sorted(level_events.keys(),
                        key=lambda lv: int(lv) if lv.isdigit() else 0):
        for ev in level_events[level]:
            if ev not in all_events:
                all_events.append(ev)
    # Sort in standard event order
    all_events.sort(key=lambda e: STICKER_EVENT_ORDER.index(e)
                    if e in STICKER_EVENT_ORDER else 99)
    events_str = ', '.join(all_events)

    # Line 1: "Name - Event1, Event2, ..."
    label_line1 = f'{athlete_name} - {events_str}'
    tw1 = fitz.get_text_length(label_line1, fontname=FONT_BOLD, fontsize=12)
    # Shrink font if too wide
    fs1 = 12
    if tw1 > PAGE_W - 160:
        fs1 = 10
        tw1 = fitz.get_text_length(label_line1, fontname=FONT_BOLD, fontsize=fs1)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw1 / 2, 148),
                     label_line1, fontname=FONT_BOLD, fontsize=fs1, color=BLACK)

    # Line 2: Gym name
    tw2 = fitz.get_text_length(gym, fontname=FONT_REGULAR, fontsize=12)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw2 / 2, 164),
                     gym, fontname=FONT_REGULAR, fontsize=12, color=BLACK)


def _extract_state(meet_name: str) -> str:
    """Try to extract state name from meet name."""
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
