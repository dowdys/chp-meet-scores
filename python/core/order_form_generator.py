"""Order form PDF generator using template overlay.

Uses the 2026 Order Form IDML/PDF as a base template. A state-specific
template is created on-the-fly (correct logo, state abbreviation, dates),
then for each athlete, copies the template page and adds athlete-specific
fields (sticker label with name, events, gym).
"""

import logging
import os
import sys
import sqlite3
from collections import defaultdict
import fitz  # PyMuPDF

from python.core.constants import (
    EVENTS as EVENT_ORDER, EVENT_DISPLAY, state_to_abbrev,
    PAGE_W, PAGE_H, BLACK,
)
from python.core.layout_engine import precompute_shirt_data, clean_name_for_shirt
from python.core.rendering_utils import draw_star_polygon as _draw_star
from python.core.pdf_generator import (
    add_shirt_back_pages, add_shirt_back_pages_from_pdf,
    _search_by_word_proximity,
)
from python.core.order_form_idml import get_state_template

logger = logging.getLogger(__name__)

# Order-form-specific red (darker than the constants.py RED used on shirts)
ORDER_FORM_RED = (0.8, 0, 0)

FONT_ITALIC = 'Times-Italic'

# PyInstaller extracts --add-data files relative to sys._MEIPASS;
# in dev/system-Python mode, resolve relative to this source file.
_BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(_BASE_DIR, 'templates')
TEMPLATE_PDF = os.path.join(TEMPLATE_DIR, 'order_form_template.pdf')

# Event display order for sticker label
STICKER_EVENT_ORDER = ['Vault', 'Bars', 'Beam', 'Floor', 'All Around']


def _format_date(date_str: str, fallback_year: str = '') -> str:
    """Format a date string to 'April 4, 2026' style.

    Handles: '2026-04-04', 'April 4, 2026', 'april 4', '4/4/2026', 'Apr 4, 2026', 'TBD'
    If the date has no year, uses fallback_year (the meet year).
    """
    if not date_str or date_str.upper() == 'TBD':
        return 'TBD'
    import re
    from datetime import datetime

    date_str = date_str.strip()

    # Already in good format like "April 4, 2026" (full month name, not abbreviated)
    if re.match(r'^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$', date_str):
        return date_str

    def _strip_leading_zero(formatted: str) -> str:
        """Remove leading zero from day: 'April 04, 2026' → 'April 4, 2026'"""
        return re.sub(r'(\w+ )0(\d,)', r'\1\2', formatted)

    # Try common formats that include a year
    for fmt in ('%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y', '%B %d, %Y', '%B %d %Y',
                '%b %d, %Y', '%b %d %Y', '%m-%d-%Y'):
        try:
            dt = datetime.strptime(date_str, fmt)
            return _strip_leading_zero(dt.strftime('%B %d, %Y'))
        except ValueError:
            continue

    # Try year-less formats — use the meet year as fallback
    year = fallback_year or ''
    for fmt in ('%B %d', '%b %d', '%B %d,', '%b %d,', '%m/%d', '%m-%d'):
        try:
            dt = datetime.strptime(date_str.rstrip(','), fmt.rstrip(','))
            month_day = _strip_leading_zero(dt.strftime('%B %d,'))
            if year:
                return f'{month_day} {year}'
            return month_day.rstrip(',')  # No year available — return without comma
        except ValueError:
            continue

    # If nothing worked, return as-is
    return date_str


def generate_order_forms_pdf(db_path: str, meet_name: str, output_path: str,
                             year: str = '2026', state: str = '',
                             state_abbrev: str = '',
                             postmark_date: str = 'TBD',
                             online_date: str = 'TBD',
                             ship_date: str = 'TBD',
                             layout=None,
                             name_sort: str = 'age',
                             level_groups: str = None,
                             exclude_levels: str = None,
                             shirt_pdf_path: str = None,
                             precomputed: dict = None,
                             division_order: list = None):
    """Generate per-athlete order form PDF using the template overlay approach.

    Each athlete gets an order form page (template with filled-in variables)
    followed by back-of-shirt page(s) with a red star next to their name.

    The template is customized per-state: correct logo, abbreviation, and
    dates are baked in. Only the athlete sticker label is added per-page.
    """
    # Format dates to "April 4, 2026" style regardless of input format.
    # Use the meet year as fallback if the agent omits the year.
    postmark_date = _format_date(postmark_date, fallback_year=year)
    online_date = _format_date(online_date, fallback_year=year)
    ship_date = _format_date(ship_date, fallback_year=year)

    # Resolve explicit division order: prefer what's stored in precomputed data
    # (since it was already used to sort shirt backs), fall back to the caller-
    # supplied list, then None (which triggers alphabetical fallback with a warning).
    if precomputed is not None and 'division_order' in precomputed:
        _div_order = precomputed['division_order']
    else:
        _div_order = division_order
    gym_athletes = _get_gym_athletes(db_path, meet_name, explicit_order=_div_order)
    if not gym_athletes:
        doc = fitz.open()
        doc.new_page(width=PAGE_W, height=PAGE_H)
        doc.save(output_path)
        doc.close()
        return

    if not state:
        state = _extract_state(meet_name)
    if not state_abbrev:
        state_abbrev = state_to_abbrev(state)  # "Arkansas" -> "AR"

    # When shirt_pdf_path is provided (IDML import), use the rendered PDF
    # as the visual base for back pages so designer edits are preserved.
    use_pdf_overlay = shirt_pdf_path and os.path.exists(shirt_pdf_path)

    shirt_data = None
    if not use_pdf_overlay:
        # Use precomputed data if provided, otherwise compute
        if precomputed is not None:
            shirt_data = precomputed
        else:
            shirt_data = precompute_shirt_data(db_path, meet_name,
                                               name_sort=name_sort,
                                               layout=layout,
                                               level_groups=level_groups,
                                               exclude_levels=exclude_levels)

    # Build state-specific template (logo + abbreviation + dates baked in)
    template_doc = get_state_template(
        state_abbrev,
        postmark_date=postmark_date,
        online_date=online_date,
        ship_date=ship_date,
        year=year,
    )

    doc = fitz.open()
    shirt_doc = None
    try:
        gyms = sorted(gym_athletes.keys())

        # Diagnostic: report which path and source is used for order form backs
        total_athletes = sum(len(a) for a in gym_athletes.values())

        # When using PDF overlay, open the shirt PDF ONCE and pre-scan all
        # athlete names across all pages.  This avoids reopening the file for
        # each of the potentially hundreds of athletes (O(1) opens instead of
        # O(N)).
        name_page_hits = {}  # cleaned_name -> [(page_idx, [Rect, ...])]

        if use_pdf_overlay:
            shirt_doc = fitz.open(shirt_pdf_path)
            logger.info("Order form backs: using PDF overlay from %s (%d pages, %.0fx%.0f)",
                        os.path.basename(shirt_pdf_path), len(shirt_doc),
                        shirt_doc[0].rect.width, shirt_doc[0].rect.height)

            # Collect every unique athlete name (cleaned) for the pre-scan
            all_athlete_names = set()
            for gym in gyms:
                for athlete_name, _le in gym_athletes[gym]:
                    all_athlete_names.add(clean_name_for_shirt(athlete_name))

            # Pre-scan: search each page for every athlete name.
            # First pass: full name search on all pages for all athletes.
            # Second pass: for athletes with ZERO hits anywhere, try prefix fallback
            # (handles names hyphenated across line breaks).
            _no_hits = set()
            for page_idx in range(len(shirt_doc)):
                src_page = shirt_doc[page_idx]
                for name in all_athlete_names:
                    hits = src_page.search_for(name)
                    if hits:
                        name_page_hits.setdefault(name, []).append((page_idx, hits))
            # Find athletes with zero hits across all pages — likely hyphenated
            # in the PDF (soft hyphen splits long names across lines).
            # Fallback: search for individual words and verify proximity.
            _no_hits = all_athlete_names - set(name_page_hits.keys())
            if _no_hits:
                logger.info("Order form pre-scan: %d names not found, trying word-proximity fallback", len(_no_hits))
                for page_idx in range(len(shirt_doc)):
                    src_page = shirt_doc[page_idx]
                    for name in list(_no_hits):
                        if name in name_page_hits:
                            continue
                        hits = _search_by_word_proximity(src_page, name)
                        if hits:
                            name_page_hits.setdefault(name, []).append((page_idx, hits))
                            logger.info("  Found '%s' via word proximity on page %d", name, page_idx + 1)
        else:
            _pg_count = len(shirt_data['page_groups']) if shirt_data else 0
            logger.info("Order form backs: using code-generated path (%d page groups)", _pg_count)

        logger.info("Order forms: %d athletes across %d gyms (expect %d 2-page forms = %d pages)",
                     total_athletes, len(gyms), total_athletes, total_athletes * 2)

        backs_found = 0
        backs_missing = 0

        # Sort athletes by back page, then alphabetically by gym within each page.
        # This groups all athletes on the same shirt back together.
        if use_pdf_overlay and shirt_doc and shirt_doc.page_count > 1:
            # Build page→gym→athletes mapping
            page_gym_athletes = {}  # {page_idx: {gym: [(name, level_events)]}}
            for gym in gyms:
                for athlete_name, level_events in gym_athletes[gym]:
                    clean = clean_name_for_shirt(athlete_name)
                    # Find which page this athlete is on
                    athlete_page = 0  # default to first page
                    if clean in name_page_hits:
                        # Use the first page they appear on
                        athlete_page = name_page_hits[clean][0][0]
                    page_gym_athletes.setdefault(athlete_page, {}).setdefault(gym, []).append(
                        (athlete_name, level_events))
            # Iterate by page order, then gym alphabetically
            _sorted_athletes = []
            for page_idx in sorted(page_gym_athletes.keys()):
                for gym in sorted(page_gym_athletes[page_idx].keys()):
                    for athlete_name, level_events in page_gym_athletes[page_idx][gym]:
                        _sorted_athletes.append((gym, athlete_name, level_events))
        else:
            # No multi-page sorting needed — just alphabetical by gym
            _sorted_athletes = []
            for gym in gyms:
                for athlete_name, level_events in gym_athletes[gym]:
                    _sorted_athletes.append((gym, athlete_name, level_events))

        for gym, athlete_name, level_events in _sorted_athletes:
                pages_before = len(doc)

                # Copy state-specific template page
                page = doc.new_page(width=PAGE_W, height=PAGE_H)
                page.show_pdf_page(page.rect, template_doc, 0)

                # Add athlete-specific sticker label
                _add_athlete_label(page, athlete_name, gym, level_events)

                # Append back-of-shirt page(s) with red star
                if use_pdf_overlay:
                    add_shirt_back_pages_from_pdf(
                        doc, shirt_pdf_path, athlete_name,
                        shirt_doc=shirt_doc, name_page_hits=name_page_hits,
                    )
                else:
                    add_shirt_back_pages(doc, shirt_data, athlete_name, year, state)

                # Track if back pages were added (front page = 1, so >1 means backs exist)
                pages_added = len(doc) - pages_before
                if pages_added > 1:
                    backs_found += 1
                else:
                    backs_missing += 1
                    if backs_missing <= 5:  # Only log first 5 to avoid spam
                        logger.warning('No back pages found for "%s" (%s) -- adding back without star', athlete_name, gym)
                    # Fallback: add the appropriate back page WITHOUT a star.
                    # A back without a star is better than no back at all.
                    if use_pdf_overlay and shirt_doc and shirt_doc.page_count > 0:
                        xcel_levels = {'XS', 'XP', 'XD', 'XSA', 'XB', 'XG'}
                        athlete_levels = set(level_events.keys())
                        # If any of the athlete's levels are XCEL, use page 0; otherwise page 1
                        if athlete_levels & xcel_levels:
                            fallback_page = 0
                        else:
                            fallback_page = min(1, shirt_doc.page_count - 1)
                        src = shirt_doc[fallback_page]
                        pw, ph = src.rect.width, src.rect.height
                        new_pg = doc.new_page(width=pw, height=ph)
                        new_pg.show_pdf_page(new_pg.rect, shirt_doc, fallback_page)

        if backs_missing > 0:
            logger.info("Order form backs: %d athletes have backs, %d athletes MISSING backs",
                        backs_found, backs_missing)
        else:
            logger.info("Order form backs: all %d athletes have back pages", backs_found)

        doc.save(output_path)
    finally:
        if shirt_doc is not None:
            shirt_doc.close()
        template_doc.close()
        doc.close()


def _add_athlete_label(page, athlete_name, gym, level_events):
    """Add athlete-specific sticker label to the order form page.

    Two lines centered in the white space, flanked by big red stars:
      *  Name - Event1, Event2  *
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

    # Use TextWriter with explicit Font objects -- page.insert_text() loses
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

    # Vertical centering: white space y~122 to y~178
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

    # Big red stars on both sides -- spanning both lines vertically
    star_r = 12  # outer radius -- big enough to span both lines + extra
    star_cy = (y_line1 + y_line2) / 2 - 3  # vertically centered between lines
    star_gap = 6  # gap between star and text
    _draw_star(page, x_text - star_gap - star_r, star_cy,
               star_r, star_r * 0.4, color=ORDER_FORM_RED)
    _draw_star(page, x_text + tw1 + star_gap + star_r, star_cy,
               star_r, star_r * 0.4, color=ORDER_FORM_RED)


def _extract_state(meet_name: str) -> str:
    """Try to extract state name from meet name."""
    parts = meet_name.split()
    for i, part in enumerate(parts):
        if part.lower() == 'state' and i > 0:
            return parts[i - 1]
    return ''


def _get_gym_athletes(db_path: str, meet_name: str, explicit_order: list = None):
    """Get winners grouped by gym, then by athlete with events per level.

    Args:
        explicit_order: Optional list of division names youngest-to-oldest
            (same format as --division-order). When provided, overrides the
            alphabetical fallback in detect_division_order so within-gym sort
            reflects the correct age ordering used on shirt backs.
    """
    from python.core.division_detector import detect_division_order

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()

        div_order, _warnings = detect_division_order(db_path, meet_name, explicit_order=explicit_order)

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
        for gym, raw_name, level, division, event in cur.fetchall():
            name = clean_name_for_shirt(raw_name)
            if not name:
                continue
            display = EVENT_DISPLAY.get(event, event)
            if display not in gym_data[gym][name][level]:
                gym_data[gym][name][level].append(display)
            key = (gym, name)
            div_sort = div_order.get(division, 99)
            if key not in athlete_divisions or div_sort < athlete_divisions[key]:
                athlete_divisions[key] = div_sort
    finally:
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
