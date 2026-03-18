"""Order form PDF generator using template overlay.

Uses the 2026 Order Form IDML/PDF as a base template. A state-specific
template is created on-the-fly (correct logo, state abbreviation, dates),
then for each athlete, copies the template page and adds athlete-specific
fields (sticker label with name, events, gym).
"""

import math
import os
import sys
import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

from python.core.constants import EVENTS as EVENT_ORDER, EVENT_DISPLAY, state_to_abbrev
from python.core.pdf_generator import (
    _draw_small_caps, _measure_small_caps_width,
    precompute_shirt_data, add_shirt_back_pages,
    add_shirt_back_pages_from_pdf
)
from python.core.order_form_idml import get_state_template

PAGE_W = 612
PAGE_H = 792
WHITE = (1, 1, 1)
BLACK = (0, 0, 0)
RED = (0.8, 0, 0)
FONT_BOLD = 'Times-Bold'
FONT_REGULAR = 'Times-Roman'
FONT_ITALIC = 'Times-Italic'

# PyInstaller extracts --add-data files relative to sys._MEIPASS;
# in dev/system-Python mode, resolve relative to this source file.
_BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(_BASE_DIR, 'templates')
TEMPLATE_PDF = os.path.join(TEMPLATE_DIR, 'order_form_template.pdf')

# Event display order for sticker label
STICKER_EVENT_ORDER = ['Vault', 'Bars', 'Beam', 'Floor', 'AA']


def generate_order_forms_pdf(db_path: str, meet_name: str, output_path: str,
                             year: str = '2026', state: str = '',
                             state_abbrev: str = '',
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
                             level_groups: str = None,
                             exclude_levels: str = None,
                             copyright: str = None, accent_color: str = None,
                             font_family: str = None, sport: str = None,
                             title_prefix: str = None, header_size: float = None,
                             divider_size: float = None,
                             shirt_pdf_path: str = None):
    """Generate per-athlete order form PDF using the template overlay approach.

    Each athlete gets an order form page (template with filled-in variables)
    followed by back-of-shirt page(s) with a red star next to their name.

    The template is customized per-state: correct logo, abbreviation, and
    dates are baked in. Only the athlete sticker label is added per-page.
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
    if not state_abbrev:
        state_abbrev = state_to_abbrev(state)  # "Arkansas" → "AR"

    # When shirt_pdf_path is provided (IDML import), use the rendered PDF
    # as the visual base for back pages so designer edits are preserved.
    use_pdf_overlay = shirt_pdf_path and os.path.exists(shirt_pdf_path)

    shirt_data = None
    if not use_pdf_overlay:
        # Pre-compute shirt data for back pages (standard code-rendered path)
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
                                           level_groups=level_groups,
                                           exclude_levels=exclude_levels,
                                           copyright=copyright,
                                           accent_color=accent_color,
                                           font_family=font_family,
                                           sport=sport,
                                           title_prefix=title_prefix,
                                           header_size=header_size,
                                           divider_size=divider_size)

    # Build state-specific template (logo + abbreviation + dates baked in)
    template_doc = get_state_template(
        state_abbrev,
        postmark_date=postmark_date,
        online_date=online_date,
        ship_date=ship_date,
    )

    doc = fitz.open()
    gyms = sorted(gym_athletes.keys())

    for gym in gyms:
        athletes = gym_athletes[gym]
        for athlete_name, level_events in athletes:
            # Copy state-specific template page
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            page.show_pdf_page(page.rect, template_doc, 0)

            # Add athlete-specific sticker label
            _add_athlete_label(page, athlete_name, gym, level_events)

            # Append back-of-shirt page(s) with red star
            if use_pdf_overlay:
                add_shirt_back_pages_from_pdf(doc, shirt_pdf_path, athlete_name)
            else:
                add_shirt_back_pages(doc, shirt_data, athlete_name, year, state)

    template_doc.close()
    doc.save(output_path)
    doc.close()


def _draw_star(page, cx, cy, outer_r, inner_r, color=RED):
    """Draw a filled 5-pointed star polygon."""
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


def _add_athlete_label(page, athlete_name, gym, level_events):
    """Add athlete-specific sticker label to the order form page.

    Two lines centered in the white space, flanked by big red stars:
      ★  Name - Event1, Event2  ★
              Gym Name
    """
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

    # Use TextWriter with explicit Font objects — page.insert_text() loses
    # font identity after show_pdf_page() overlay.
    font_bold = fitz.Font('tibo')     # Times Bold
    font_regular = fitz.Font('tiro')  # Times Roman

    # Line 1: "Name - Event1, Event2" in bold
    label_line1 = f'{athlete_name} - {events_str}'
    fs1 = 12
    tw1 = font_bold.text_length(label_line1, fontsize=fs1)
    if tw1 > PAGE_W - 180:
        fs1 = 10
        tw1 = font_bold.text_length(label_line1, fontsize=fs1)

    # Vertical centering: white space y≈122 to y≈178
    y_line1 = 143
    y_line2 = 159

    x_text = PAGE_W / 2 - tw1 / 2
    writer = fitz.TextWriter(page.rect)
    writer.append(fitz.Point(x_text, y_line1),
                  label_line1, font=font_bold, fontsize=fs1)
    writer.write_text(page, color=BLACK)

    # Line 2: Gym name, regular weight
    tw2 = font_regular.text_length(gym, fontsize=12)
    writer2 = fitz.TextWriter(page.rect)
    writer2.append(fitz.Point(PAGE_W / 2 - tw2 / 2, y_line2),
                   gym, font=font_regular, fontsize=12)
    writer2.write_text(page, color=BLACK)

    # Big red stars on both sides — spanning both lines vertically
    star_r = 12  # outer radius — big enough to span both lines + extra
    star_cy = (y_line1 + y_line2) / 2 - 3  # vertically centered between lines
    star_gap = 6  # gap between star and text
    _draw_star(page, x_text - star_gap - star_r, star_cy,
               star_r, star_r * 0.4, color=RED)
    _draw_star(page, x_text + tw1 + star_gap + star_r, star_cy,
               star_r, star_r * 0.4, color=RED)


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
