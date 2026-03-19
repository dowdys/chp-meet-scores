"""Shared rendering utilities for PDF generation.

Drawing primitives used by pdf_generator.py and order_form_generator.py.
Requires PyMuPDF (fitz).
"""

import math
import fitz

from python.core.constants import (
    BLACK, WHITE, RED, FONT_BOLD, OVAL_LABEL_SIZE, PAGE_W, COL_CENTERS,
)


def draw_small_caps(page, center_x: float, y: float, text: str,
                    large_size: float, small_size: float,
                    color: tuple = None, font: str = None) -> float:
    """Draw text in small caps, centered horizontally.

    First letter of each word at large_size, rest at small_size.
    All characters rendered uppercase.
    """
    if color is None:
        color = BLACK
    if font is None:
        font = FONT_BOLD
    total_width = measure_small_caps_width(text, large_size, small_size, font=font)
    x = center_x - total_width / 2

    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            space_w = fitz.get_text_length(' ', fontname=font, fontsize=large_size)
            x += space_w

        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            page.insert_text(fitz.Point(x, y), ch_upper,
                             fontname=font, fontsize=fs, color=color)
            x += fitz.get_text_length(ch_upper, fontname=font, fontsize=fs)


def measure_small_caps_width(text: str, large_size: float,
                             small_size: float, font: str = None) -> float:
    """Measure total width of small-caps text."""
    if font is None:
        font = FONT_BOLD
    total = 0
    words = text.split()
    for wi, word in enumerate(words):
        if wi > 0:
            total += fitz.get_text_length(' ', fontname=font, fontsize=large_size)
        for ci, ch in enumerate(word):
            ch_upper = ch.upper()
            fs = large_size if ci == 0 else small_size
            total += fitz.get_text_length(ch_upper, fontname=font, fontsize=fs)
    return total


def draw_oval(page, label: str, y_center: float, color: tuple = None,
              font: str = None) -> None:
    """Draw a filled oval with white text label."""
    if color is None:
        color = RED
    if font is None:
        font = FONT_BOLD
    tw = fitz.get_text_length(label, fontname=font, fontsize=OVAL_LABEL_SIZE)
    # Oval spans from Bars column to Floor column (wider than just text)
    text_w = tw + 40
    col_span_w = (COL_CENTERS[3] + 60) - (COL_CENTERS[1] - 60)
    oval_w = max(text_w, col_span_w)
    oval_h = 22

    x0 = PAGE_W / 2 - oval_w / 2
    x1 = PAGE_W / 2 + oval_w / 2
    y0 = y_center - oval_h / 2
    y1 = y_center + oval_h / 2

    rect = fitz.Rect(x0, y0, x1, y1)
    page.draw_oval(rect, color=color, fill=color)

    # White text centered in oval (y positions at baseline)
    text_x = PAGE_W / 2 - tw / 2
    text_y = y_center + OVAL_LABEL_SIZE * 0.35
    page.insert_text(fitz.Point(text_x, text_y), label,
                     fontname=font, fontsize=OVAL_LABEL_SIZE, color=WHITE)


def draw_star_polygon(page, cx: float, cy: float, outer_r: float,
                      inner_r: float, color: tuple = RED) -> None:
    """Draw a filled 5-pointed star as a polygon."""
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
