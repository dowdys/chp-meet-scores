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

import os
import math
import fitz  # PyMuPDF

# Import constants from centralized location
from python.core.constants import (
    EVENTS as EVENT_KEYS, COL_HEADERS, COL_CENTERS,
    PAGE_W, PAGE_H, PAGE_H_LEGAL,
    RED, WHITE, BLACK, YELLOW_HL,
    DEFAULT_SPORT, DEFAULT_TITLE_PREFIX, DEFAULT_COPYRIGHT,
    FONT_REGULAR, FONT_BOLD,
    TITLE1_LARGE, TITLE1_SMALL, TITLE2_LARGE, TITLE2_SMALL,
    HEADER_LARGE, HEADER_SMALL, LEVEL_DIVIDER_SIZE, OVAL_LABEL_SIZE,
    DEFAULT_NAME_SIZE, MIN_NAME_SIZE, COPYRIGHT_SIZE, COPYRIGHT_Y,
    NAMES_BOTTOM_Y, NAMES_START_Y,
    LINE_HEIGHT_RATIO, LEVEL_GAP, MAX_PAGE_FILL,
    XCEL_MAP, XCEL_PRESTIGE_ORDER as XCEL_ORDER,
)

# Import layout/data functions from layout_engine
from python.core.layout_engine import (
    precompute_shirt_data, _compute_layout, _fit_font_size,
    _bin_pack_levels, _level_height, _space_text,
    _clean_name_for_shirt, _flag_suspicious_name,
    _get_winners_by_event_and_level,
    _get_winners_with_gym, _get_all_winner_gyms,
    _parse_hex_color, _label_numbered_group, _parse_level_groups, _label_group,
)

# Import rendering primitives from rendering_utils
from python.core.rendering_utils import (
    _draw_small_caps, _measure_small_caps_width,
    _draw_oval, _draw_star_polygon,
)


def add_shirt_back_pages(doc, precomputed, athlete_name, year, state):
    """Append back-of-shirt page(s) to doc with a red star next to athlete_name.

    Only includes page groups where the athlete appears. Each matching page
    group gets one page appended to doc.
    """
    page_groups = precomputed['page_groups']
    data = precomputed['data']
    _page_h = precomputed.get('page_h', PAGE_H)
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

        page = doc.new_page(width=PAGE_W, height=_page_h)

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
                                    names_start_y=p_names_start, divider_size=s_ds,
                                    page_h=_page_h)
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

        _draw_copyright(page, text=s_copyright, font=s_freg, page_h=_page_h)


def generate_shirt_pdf(db_path: str, meet_name: str, output_path: str,
                       year: str = '2026', state: str = 'Maryland',
                       layout=None,  # LayoutParams object
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
                       divider_size: float = None, page_h: int = None,
                       page_group_filter: list = None,
                       precomputed: dict = None):
    """Generate enhanced back-of-shirt PDF."""
    _page_h = page_h or PAGE_H
    # Use precomputed data if provided, otherwise compute
    if precomputed is not None:
        pre = precomputed
    else:
        pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                    layout=layout,
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
                                    divider_size=divider_size,
                                    page_h=_page_h)
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
        doc.new_page(width=PAGE_W, height=_page_h)
        doc.save(output_path)
        doc.close()
        return

    # Generate PDF
    doc = fitz.open()

    for label, group_levels in page_groups:
        # Filter page groups when generating legal-size subset
        if page_group_filter is not None:
            if not any(f.upper() in label.upper() for f in page_group_filter):
                continue
        page = doc.new_page(width=PAGE_W, height=_page_h)

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
                                    divider_size=s_ds, page_h=_page_h)
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
        _draw_copyright(page, text=s_copyright, font=s_freg, page_h=_page_h)

    doc.save(output_path)
    doc.close()


# --- Drawing functions (kept here as they are PDF-specific rendering) ---

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


def _draw_names(page, y, col_idx, names, font_size, line_height,
                highlight_names=None, star_names=None,
                font_regular=None, font_bold=None, accent_color=None):
    """Draw a centered list of names in the given column.

    Args:
        highlight_names: Optional set of name strings. Names in this set
            render in bold with a yellow highlight rectangle behind them.
        star_names: Optional set of name strings. Names in this set get
            a large red star drawn just to the left of the name text.
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


def _draw_copyright(page, text=None, font=None, page_h=None):
    """Draw copyright footer at page bottom."""
    if text is None:
        text = DEFAULT_COPYRIGHT
    if font is None:
        font = FONT_REGULAR
    _copyright_y = (page_h or PAGE_H) - 8
    tw = fitz.get_text_length(text, fontname=font, fontsize=COPYRIGHT_SIZE)
    page.insert_text(fitz.Point(PAGE_W / 2 - tw / 2, _copyright_y), text,
                     fontname=font, fontsize=COPYRIGHT_SIZE, color=BLACK)


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


# --- Gym Highlights PDF ---

def generate_gym_highlights_pdf(db_path, meet_name, output_path,
                                year='2026', state='Maryland',
                                layout=None,  # LayoutParams object
                                line_spacing=None, level_gap=None,
                                max_fill=None, min_font_size=None,
                                max_font_size=None, name_sort='age',
                                max_shirt_pages=None,
                                title1_size=None, title2_size=None,
                                level_groups=None, exclude_levels=None,
                                copyright=None, accent_color=None,
                                font_family=None, sport=None,
                                title_prefix=None, header_size=None,
                                divider_size=None, page_h=None,
                                precomputed: dict = None):
    """Generate a gym highlights version of the back-of-shirt PDF.

    For each gym (alphabetically), generates the same back-of-shirt pages
    but with that gym's athletes highlighted in bold. The gym name is arched
    in the top-left and top-right corners.

    Only includes pages that contain at least one of that gym's athletes.
    """
    _page_h = page_h or PAGE_H
    # Use precomputed data if provided, otherwise compute
    if precomputed is not None:
        pre = precomputed
    else:
        pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                    layout=layout,
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
                                    divider_size=divider_size,
                                    page_h=_page_h)
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
        doc.new_page(width=PAGE_W, height=_page_h)
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
    gh_gym_name_y = p_title2_y + round(t2l * 0.8) + 3
    gh_oval_y = gh_gym_name_y + 21
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

            page = doc.new_page(width=PAGE_W, height=_page_h)

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
                                        names_start_y=gh_names_start, divider_size=s_ds,
                                        page_h=_page_h)
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

            _draw_copyright(page, text=s_copyright, font=s_freg, page_h=_page_h)

    doc.save(output_path)
    doc.close()


def generate_gym_highlights_from_pdf(shirt_pdf_path, db_path, meet_name, output_path,
                                     exclude_shirt_path=None):
    """Generate gym highlights by overlaying on an existing shirt PDF.

    Uses the rendered back_of_shirt.pdf as the visual base, so any designer
    edits (fonts, colors, layout, spacing) in the IDML are preserved.
    For each gym, copies the relevant shirt pages and adds yellow highlight
    annotations on that gym's athlete names.

    Args:
        exclude_shirt_path: Optional path to another shirt PDF (e.g. the 8.5x14
            version). Names that appear on pages of the exclude PDF will be
            skipped in this output, preventing duplicate coverage across the
            8.5x11 and 8.5x14 gym highlights files.
    """
    shirt_doc = fitz.open(shirt_pdf_path)
    # Read page dimensions from the source PDF (handles both letter and legal)
    _src_w = shirt_doc[0].rect.width if len(shirt_doc) > 0 else PAGE_W
    _src_h = shirt_doc[0].rect.height if len(shirt_doc) > 0 else PAGE_H
    name_to_gym = _get_winners_with_gym(db_path, meet_name)
    all_gyms = _get_all_winner_gyms(db_path, meet_name)

    # Build set of names to exclude (names that appear on the exclude PDF)
    exclude_names = set()
    if exclude_shirt_path and os.path.exists(exclude_shirt_path):
        try:
            excl_doc = fitz.open(exclude_shirt_path)
            for pi in range(len(excl_doc)):
                text = excl_doc[pi].get_text()
                for name in name_to_gym:
                    if name in text:
                        exclude_names.add(name)
            excl_doc.close()
        except Exception:
            pass  # If exclude PDF can't be read, include all names

    if not all_gyms:
        shirt_doc.close()
        doc = fitz.open()
        doc.new_page(width=_src_w, height=_src_h)
        doc.save(output_path)
        doc.close()
        return

    # Pre-compute text search hits for each name on each source page
    page_name_quads = []
    for pi in range(len(shirt_doc)):
        src = shirt_doc[pi]
        hits = {}
        for name in name_to_gym:
            quads = src.search_for(name, quads=True)
            if quads:
                hits[name] = quads
        page_name_quads.append(hits)

    doc = fitz.open()

    for gym in all_gyms:
        gym_names = {n for n, g in name_to_gym.items()
                     if g == gym and n not in exclude_names}

        for pi in range(len(shirt_doc)):
            hits_on_page = page_name_quads[pi]
            matched = {n: hits_on_page[n] for n in gym_names if n in hits_on_page}
            if not matched:
                continue

            # Copy the shirt page (using source dimensions)
            src_page = shirt_doc[pi]
            pw, ph = src_page.rect.width, src_page.rect.height
            page = doc.new_page(width=pw, height=ph)
            page.show_pdf_page(page.rect, shirt_doc, pi)

            # Add yellow highlight annotations
            for name, quads in matched.items():
                annot = page.add_highlight_annot(quads)
                annot.set_colors(stroke=(1, 1, 0))
                annot.update()

            # Draw gym name between title and oval with a white background
            # for breathing room. Find the title bottom and oval top.
            gym_display = gym.upper()
            gym_fs = 10
            tw = fitz.get_text_length(gym_display, fontname=FONT_BOLD, fontsize=gym_fs)
            while tw > pw - 60 and gym_fs > 7:
                gym_fs -= 0.5
                tw = fitz.get_text_length(gym_display, fontname=FONT_BOLD, fontsize=gym_fs)

            # Find the title bottom and oval top from page content
            title_bottom_y = 57  # fallback
            oval_top_y = 70      # fallback
            for d in page.get_drawings():
                if d.get('fill') and d['rect'].y0 > 30 and d['rect'].y0 < 150:
                    fill = d['fill']
                    if fill and len(fill) >= 3 and fill[0] > 0.5 and fill[1] < 0.3:
                        oval_top_y = d['rect'].y0
                        break
            # Search for the title2 baseline (largest text near y=40-60)
            for b in page.get_text('dict')['blocks']:
                if 'lines' not in b:
                    continue
                for line in b['lines']:
                    for span in line['spans']:
                        sy = span['origin'][1]
                        if 40 < sy < 65 and span['size'] >= 15:
                            title_bottom_y = max(title_bottom_y, sy + span['size'] * 0.3)

            # Draw white background rect to create space between title and oval
            gap_top = title_bottom_y + 1
            gap_bottom = oval_top_y
            if gap_bottom - gap_top < gym_fs + 4:
                # Not enough space -- extend by blanking into the oval top
                gap_bottom = gap_top + gym_fs + 6
            bg_rect = fitz.Rect(pw / 2 - tw / 2 - 8, gap_top,
                                pw / 2 + tw / 2 + 8, gap_bottom)
            page.draw_rect(bg_rect, fill=WHITE, color=WHITE, width=0)

            # Center gym name in the gap
            # Use TextWriter with explicit Font -- insert_text() loses font
            # identity after show_pdf_page() overlay (PyMuPDF known issue).
            gym_name_y = gap_top + (gap_bottom - gap_top) / 2 + gym_fs * 0.35
            gym_tw = fitz.TextWriter(page.rect)
            gym_font = fitz.Font('tibo')  # Times Bold
            gym_tw.append(fitz.Point(pw / 2 - tw / 2, gym_name_y),
                          gym_display, font=gym_font, fontsize=gym_fs)
            gym_tw.write_text(page, color=RED)

    shirt_doc.close()
    doc.save(output_path)
    doc.close()


def add_shirt_back_pages_from_pdf(doc, shirt_pdf_path, athlete_name):
    """Append back-of-shirt pages from an existing PDF with a red star overlay.

    Used during IDML import so designer edits are preserved. Copies pages
    from the shirt PDF where the athlete appears, overlaying a red star
    next to each occurrence of their name.
    """
    # Clean the name to match what's on the shirt PDF (which uses cleaned names)
    search_name = _clean_name_for_shirt(athlete_name)
    shirt_doc = fitz.open(shirt_pdf_path)

    for pi in range(len(shirt_doc)):
        src = shirt_doc[pi]
        hits = src.search_for(search_name)
        if not hits:
            continue

        pw, ph = src.rect.width, src.rect.height
        page = doc.new_page(width=pw, height=ph)
        page.show_pdf_page(page.rect, shirt_doc, pi)

        for rect in hits:
            font_size = rect.height * 0.8
            star_r = font_size * 0.65
            star_cx = rect.x0 - star_r - 3
            star_cy = (rect.y0 + rect.y1) / 2
            _draw_star_polygon(page, star_cx, star_cy, star_r, star_r * 0.4,
                               color=RED)

    shirt_doc.close()
