"""Order form PDF generator using template overlay.

Uses the 2026 Order Form IDML/PDF as a base template. A state-specific
template is created on-the-fly (correct logo, state abbreviation, dates),
then for each athlete, copies the template page and adds athlete-specific
fields (sticker label with name, events, gym).
"""

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


def _add_athlete_label(page, athlete_name, gym, level_events):
    """Add athlete-specific sticker label to the order form page.

    Places the athlete name, events, and gym name in the blank area
    between the subtitle and the accomplishment line.
    Three lines, centered:
      1. Athlete name — bold, larger font
      2. Events — regular, smaller font
      3. Gym name — italic, smaller font
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
    font_italic = fitz.Font('tiit')   # Times Italic

    fs_name = 16
    fs_detail = 11

    # Check if name is too wide and shrink if needed
    tw_name = font_bold.text_length(athlete_name, fontsize=fs_name)
    if tw_name > PAGE_W - 160:
        fs_name = 14
        tw_name = font_bold.text_length(athlete_name, fontsize=fs_name)

    # Vertical centering: white space runs y≈120 to y≈178.
    y_name = 137
    y_events = 153
    y_gym = 168

    # Line 1: Athlete name — bold, 16pt
    writer = fitz.TextWriter(page.rect)
    writer.append(fitz.Point(PAGE_W / 2 - tw_name / 2, y_name),
                  athlete_name, font=font_bold, fontsize=fs_name)
    writer.write_text(page, color=BLACK)

    # Line 2: Events — regular, 11pt
    tw_ev = font_regular.text_length(events_str, fontsize=fs_detail)
    writer2 = fitz.TextWriter(page.rect)
    writer2.append(fitz.Point(PAGE_W / 2 - tw_ev / 2, y_events),
                   events_str, font=font_regular, fontsize=fs_detail)
    writer2.write_text(page, color=BLACK)

    # Line 3: Gym name — italic, 11pt
    tw_gym = font_italic.text_length(gym, fontsize=fs_detail)
    writer3 = fitz.TextWriter(page.rect)
    writer3.append(fitz.Point(PAGE_W / 2 - tw_gym / 2, y_gym),
                   gym, font=font_italic, fontsize=fs_detail)
    writer3.write_text(page, color=BLACK)


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
