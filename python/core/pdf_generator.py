"""Unified shirt PDF generator for gymnastics meet results.

Generates a back-of-shirt PDF with title, event columns, and names
grouped by level.
"""

import sqlite3
import fitz  # PyMuPDF

# Page layout constants (letter size: 612 x 792)
PAGE_W = 612
PAGE_H = 792

# Column centers (5 columns evenly across the page)
COL_CENTERS = [62, 184, 306, 428, 550]
COL_HEADERS = ["Vault", "Bars", "Beam", "Floor", "All Around"]
EVENT_KEYS = ["vault", "bars", "beam", "floor", "aa"]

# Font sizes
TITLE_SIZE = 22
SUBTITLE_SIZE = 16
HEADER_SIZE = 13
LEVEL_SIZE = 12
NAME_SIZE = 9

# Spacing
LINE_HEIGHT = 13
HEADER_Y = 90
NAMES_START_Y = 110
BOTTOM_MARGIN = 30
LEVEL_GAP = 4


def generate_shirt_pdf(db_path: str, meet_name: str, output_path: str,
                       title_lines: tuple[str, ...] = ()):
    """Generate a back-of-shirt PDF.

    Args:
        db_path: Path to SQLite database.
        meet_name: Meet name to filter by.
        output_path: Where to save the PDF.
        title_lines: Up to 3 lines for the title block.
    """
    levels, data = _get_winners_by_event_and_level(db_path, meet_name)
    level_lines = _calculate_column_lines(levels, data)

    available_height = PAGE_H - NAMES_START_Y - BOTTOM_MARGIN
    pages_levels = _paginate_levels(levels, level_lines, available_height)

    doc = fitz.open()

    for page_levels in pages_levels:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        _draw_title(page, title_lines)
        _draw_headers(page)

        y = NAMES_START_Y
        for level in page_levels:
            y += LEVEL_GAP
            _draw_level_divider(page, y, f"Level {level}")
            y += LINE_HEIGHT

            max_names = 0
            for col_idx, event in enumerate(EVENT_KEYS):
                names = data[event].get(level, [])
                if names:
                    _draw_names(page, y, col_idx, names)
                    max_names = max(max_names, len(names))

            y += max_names * LINE_HEIGHT + 2

    doc.save(output_path)
    doc.close()


def _get_winners_by_event_and_level(db_path: str, meet_name: str):
    """Get winner names organized by event and level."""
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute('''SELECT DISTINCT level FROM winners
                   WHERE meet_name = ?
                   ORDER BY CAST(level AS INTEGER)''', (meet_name,))
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


def _calculate_column_lines(levels, data):
    """Calculate how many lines each column needs per level."""
    level_lines = {}
    for level in levels:
        max_names = 0
        for event in EVENT_KEYS:
            names = data[event].get(level, [])
            max_names = max(max_names, len(names))
        level_lines[level] = 1 + max_names + 1
    return level_lines


def _paginate_levels(levels, level_lines, available_height):
    """Split levels into pages so each page fits within available_height."""
    pages = []
    current_page = []
    current_height = 0

    for level in levels:
        needed = level_lines[level] * LINE_HEIGHT + LEVEL_GAP
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


def _draw_title(page, title_lines: tuple[str, ...]):
    """Draw the title block at the top of a page."""
    y_positions = [28, 50, 72]
    font_sizes = [TITLE_SIZE, SUBTITLE_SIZE, SUBTITLE_SIZE]

    for i, line_text in enumerate(title_lines[:3]):
        fs = font_sizes[i]
        tw = fitz.get_text_length(line_text, fontname="Times-Bold", fontsize=fs)
        page.insert_text(
            fitz.Point(PAGE_W / 2 - tw / 2, y_positions[i]),
            line_text, fontname="Times-Bold", fontsize=fs
        )


def _draw_headers(page):
    """Draw event column headers."""
    for i, header in enumerate(COL_HEADERS):
        cx = COL_CENTERS[i]
        tw = fitz.get_text_length(header, fontname="Times-Bold", fontsize=HEADER_SIZE)
        page.insert_text(
            fitz.Point(cx - tw / 2, HEADER_Y),
            header, fontname="Times-Bold", fontsize=HEADER_SIZE
        )


def _draw_level_divider(page, y, level_text):
    """Draw a centered bold level divider."""
    tw = fitz.get_text_length(level_text, fontname="Times-Bold", fontsize=LEVEL_SIZE)
    page.insert_text(
        fitz.Point(PAGE_W / 2 - tw / 2, y),
        level_text, fontname="Times-Bold", fontsize=LEVEL_SIZE
    )


def _draw_names(page, y, col_idx, names):
    """Draw a list of names centered in the given column."""
    cx = COL_CENTERS[col_idx]
    for name in names:
        tw = fitz.get_text_length(name, fontname="Times-Roman", fontsize=NAME_SIZE)
        page.insert_text(
            fitz.Point(cx - tw / 2, y),
            name, fontname="Times-Roman", fontsize=NAME_SIZE
        )
        y += LINE_HEIGHT
    return y
