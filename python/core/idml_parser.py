"""IDML-to-PDF converter.

Parses an InDesign IDML file (ZIP of XML) and renders it as a PDF using
PyMuPDF. This enables the round-trip workflow:

    App generates IDML → User edits in InDesign → User returns IDML →
    App converts back to PDF (pixel-accurate to the InDesign edits)

Supports: TextFrames (with rotation), Rectangles (with rotation),
Ovals, GraphicLines (including dashed), placed images (embedded TIF),
placed PDFs (state logos), and custom fonts (Bookman, Magneto, Cooper Black).
"""

import os
import sys
import math
import base64
import zipfile
from urllib.parse import unquote
from xml.etree import ElementTree as ET

import fitz  # PyMuPDF

PAGE_W = 612
PAGE_H = 792

# Unicode typographic characters → ASCII equivalents for base14 fonts
_CHAR_MAP = {
    '\u2018': "'",   # left single quote
    '\u2019': "'",   # right single quote (apostrophe)
    '\u201C': '"',   # left double quote
    '\u201D': '"',   # right double quote
    '\u2013': '-',   # en dash
    '\u2014': '--',  # em dash
    '\u2026': '...', # ellipsis
    '\u00A0': ' ',   # non-breaking space
    '\u2002': ' ',   # en space
    '\u2028': '\n',  # line separator → newline (handled as Br)
    # Tab (\t) is NOT mapped here — handled via tab stops in _wrap_paragraph
}

# InDesign default tab stop interval (0.5 inches = 36 points)
_DEFAULT_TAB_STOP = 36.0


_TAB_TOLERANCE = 1.0  # pts — covers InDesign word/letter-spacing compression


def _next_tab_stop(x):
    """Next tab stop position at or after x (36pt default intervals).

    InDesign's paragraph composer may compress word/letter spacing
    (MinimumWordSpacing/MinimumLetterSpacing), making text slightly
    narrower than our base14 font metrics predict.  A small tolerance
    prevents cursor positions that are just barely past a tab stop
    from jumping to the *next* stop.
    """
    n = int(x / _DEFAULT_TAB_STOP)
    stop = (n + 1) * _DEFAULT_TAB_STOP
    prev_stop = n * _DEFAULT_TAB_STOP
    if prev_stop > 0 and 0 < (x - prev_stop) <= _TAB_TOLERANCE:
        return prev_stop
    return stop


# ---------------------------------------------------------------------------
# Font configuration
# ---------------------------------------------------------------------------

# Map InDesign font style keywords → PyMuPDF base14 names
_STYLE_TO_FITZ = {
    ('Times New Roman', 'Regular'): 'Times-Roman',
    ('Times New Roman', 'Bold'): 'Times-Bold',
    ('Times New Roman', 'Italic'): 'Times-Italic',
    ('Times New Roman', 'Bold Italic'): 'Times-BoldItalic',
    ('Helvetica', 'Regular'): 'Helvetica',
    ('Helvetica', 'Bold'): 'Helvetica-Bold',
}

# Custom font files (tried in order; first match wins)
_CUSTOM_FONTS = {
    ('Bookman Old Style', 'Bold'): {
        'name': 'BookmanBold',
        'files': [
            '/mnt/c/Windows/Fonts/BOOKOSB.TTF',
            'C:\\Windows\\Fonts\\BOOKOSB.TTF',
        ],
    },
    ('Magneto', 'Bold'): {
        'name': 'MagnetoBold',
        'files': [
            '/mnt/c/Windows/Fonts/MAGNETOB.TTF',
            'C:\\Windows\\Fonts\\MAGNETOB.TTF',
        ],
    },
    ('Cooper Black', 'Regular'): {
        'name': 'CooperBlack',
        'files': [
            '/mnt/c/Windows/Fonts/COOPBL.TTF',
            'C:\\Windows\\Fonts\\COOPBL.TTF',
        ],
    },
}

# Cache for fitz.Font objects (used for text width measurement)
_font_objects = {}
# Cache for resolved font file paths
_font_file_cache = {}


def _resolve_font(family, style):
    """Resolve a font family + style to (fitz_name, font_file_path_or_None)."""
    key = (family, style)
    if key in _font_file_cache:
        return _font_file_cache[key]

    # Try custom fonts
    custom = _CUSTOM_FONTS.get(key)
    if custom:
        for fpath in custom['files']:
            if os.path.exists(fpath):
                _font_file_cache[key] = (custom['name'], fpath)
                return custom['name'], fpath

    # Base14 fallback
    name = _STYLE_TO_FITZ.get(key)
    if not name:
        if 'Bold' in style and 'Italic' in style:
            name = 'Times-BoldItalic'
        elif 'Bold' in style:
            name = 'Times-Bold'
        elif 'Italic' in style:
            name = 'Times-Italic'
        else:
            name = 'Times-Roman'
    _font_file_cache[key] = (name, None)
    return name, None


def _get_font_obj(fitz_name, font_file):
    """Get or create a fitz.Font for text width measurement."""
    cache_key = font_file or fitz_name
    if cache_key in _font_objects:
        return _font_objects[cache_key]
    try:
        if font_file:
            font = fitz.Font(fontfile=font_file)
        else:
            font = fitz.Font(fitz_name)
    except Exception:
        font = fitz.Font('Times-Roman')
    _font_objects[cache_key] = font
    return font


def _text_width(text, fitz_name, font_file, fontsize):
    """Measure text width using the correct font."""
    font = _get_font_obj(fitz_name, font_file)
    return font.text_length(text, fontsize=fontsize)


def _insert_text(page, point, text, fitz_name, font_file, fontsize,
                 color=(0, 0, 0), morph=None):
    """Insert text on page, handling custom fonts transparently."""
    kwargs = dict(fontname=fitz_name, fontsize=fontsize, color=color or (0, 0, 0))
    if font_file:
        kwargs['fontfile'] = font_file
    if morph:
        kwargs['morph'] = morph
    page.insert_text(point, text, **kwargs)


# ---------------------------------------------------------------------------
# Coordinate transforms
# ---------------------------------------------------------------------------

def _parse_transform(transform_str):
    """Parse ItemTransform '1 0 0 1 tx ty' → [a, b, c, d, tx, ty]."""
    parts = transform_str.split()
    if len(parts) >= 6:
        return [float(p) for p in parts[:6]]
    return [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]


def _apply_transform(x, y, transform):
    """Apply affine [a,b,c,d,tx,ty] to (x,y). Returns (spread_x, spread_y)."""
    a, b, c, d, tx, ty = transform
    return (a * x + c * y + tx, b * x + d * y + ty)


def _has_rotation(transform):
    """Check if transform includes rotation (not just translate/flip)."""
    _, b, c, _ = transform[:4]
    return abs(b) > 0.001 or abs(c) > 0.001


def _rotation_angle(transform):
    """Extract rotation angle in degrees from transform."""
    a, b = transform[0], transform[1]
    return math.degrees(math.atan2(b, a))


def _get_page_offset(spread_el):
    """Extract page origin offset from the Page element's ItemTransform."""
    for child in spread_el:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag == 'Page':
            tf = _parse_transform(child.get('ItemTransform', '1 0 0 1 0 0'))
            return (tf[4], tf[5])
    return (0.0, 0.0)


def _get_local_bounds(element):
    """Get bounds in the element's LOCAL coordinate space (no transform)."""
    anchors = []
    for ppt in element.iter('PathPointType'):
        parts = ppt.get('Anchor', '').split()
        if len(parts) >= 2:
            anchors.append((float(parts[0]), float(parts[1])))
    if not anchors:
        return None
    xs = [a[0] for a in anchors]
    ys = [a[1] for a in anchors]
    return (min(xs), min(ys), max(xs), max(ys))


def _get_page_bounds(element, page_offset):
    """Get axis-aligned bounding box in page (PDF) coordinates."""
    transform = _parse_transform(element.get('ItemTransform', '1 0 0 1 0 0'))
    anchors = []
    for ppt in element.iter('PathPointType'):
        parts = ppt.get('Anchor', '').split()
        if len(parts) >= 2:
            lx, ly = float(parts[0]), float(parts[1])
            sx, sy = _apply_transform(lx, ly, transform)
            anchors.append((sx - page_offset[0], sy - page_offset[1]))
    if not anchors:
        return None
    xs = [a[0] for a in anchors]
    ys = [a[1] for a in anchors]
    return (min(xs), min(ys), max(xs), max(ys))


def _get_page_anchors(element, page_offset):
    """Get all anchor points transformed to page coordinates."""
    transform = _parse_transform(element.get('ItemTransform', '1 0 0 1 0 0'))
    anchors = []
    for ppt in element.iter('PathPointType'):
        parts = ppt.get('Anchor', '').split()
        if len(parts) >= 2:
            lx, ly = float(parts[0]), float(parts[1])
            sx, sy = _apply_transform(lx, ly, transform)
            anchors.append((sx - page_offset[0], sy - page_offset[1]))
    return anchors


def _is_on_page(bounds, page_w=PAGE_W, page_h=PAGE_H):
    """Check if element bounds overlap the visible page area."""
    if not bounds:
        return False
    x1, y1, x2, y2 = bounds
    # Allow some margin for elements that slightly overhang
    margin = 20
    return (x2 > -margin and x1 < page_w + margin and
            y2 > -margin and y1 < page_h + margin)


# ---------------------------------------------------------------------------
# Resource loaders
# ---------------------------------------------------------------------------

_BASE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
_TEMPLATE_DIR = os.path.join(_BASE_DIR, 'templates')
_LOGO_DIR = os.path.join(_TEMPLATE_DIR, 'state_logos')


def _load_colors(zf):
    """Load color definitions from Resources/Graphic.xml."""
    colors = {
        'Color/Black': (0, 0, 0),
        'Color/Paper': (1, 1, 1),
        'Swatch/None': None,
    }
    try:
        xml = zf.read('Resources/Graphic.xml').decode('utf-8')
        root = ET.fromstring(xml)
        for color_el in root.iter('Color'):
            name = color_el.get('Name', '')
            self_id = color_el.get('Self', '')
            space = color_el.get('Space', '')
            value_str = color_el.get('ColorValue', '')
            if not value_str:
                continue
            values = [float(v) for v in value_str.split()]
            rgb = None
            if space == 'RGB' and len(values) >= 3:
                rgb = (values[0] / 255, values[1] / 255, values[2] / 255)
            elif space == 'CMYK' and len(values) >= 4:
                c, m, y, k = [v / 100 for v in values]
                rgb = ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
            if rgb is not None:
                # Index by both name and Self ID for reliable lookup
                colors[f'Color/{name}'] = rgb
                if self_id:
                    colors[self_id] = rgb
    except (KeyError, ET.ParseError):
        pass
    return colors


def _load_paragraph_styles(zf):
    """Load paragraph style definitions from Resources/Styles.xml."""
    styles = {}
    try:
        xml = zf.read('Resources/Styles.xml').decode('utf-8')
        root = ET.fromstring(xml)
        for ps in root.iter('ParagraphStyle'):
            self_id = ps.get('Self', '')
            name = ps.get('Name', '')
            styles[self_id] = {
                'justification': ps.get('Justification', ''),
                'left_indent': float(ps.get('LeftIndent', '0')),
                'first_line_indent': float(ps.get('FirstLineIndent', '0')),
                'space_before': float(ps.get('SpaceBefore', '0')),
                'space_after': float(ps.get('SpaceAfter', '0')),
                'point_size': float(ps.get('PointSize', '0')),
                'font_style': ps.get('FontStyle', ''),
            }
            # Also index by full name path (e.g., "ParagraphStyle/Hanging indent")
            if name:
                styles[f'ParagraphStyle/{name}'] = styles[self_id]
    except (KeyError, ET.ParseError):
        pass
    return styles


def _load_stories(zf):
    """Load all Story files into a dict keyed by story ID."""
    stories = {}
    for name in zf.namelist():
        if name.startswith('Stories/Story_') and name.endswith('.xml'):
            xml = zf.read(name).decode('utf-8')
            root = ET.fromstring(xml)
            story_el = root.find('.//{*}Story')
            if story_el is None:
                for child in root:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'Story':
                        story_el = child
                        break
            if story_el is None:
                story_el = root
            story_id = story_el.get('Self', '')
            stories[story_id] = story_el
    return stories


def _get_spread_files(zf):
    """Get ordered list of spread file paths from designmap.xml."""
    try:
        xml = zf.read('designmap.xml').decode('utf-8')
        root = ET.fromstring(xml)
        files = []
        for child in root:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'Spread':
                src = child.get('src', '')
                if src:
                    files.append(src)
        if files:
            return files
    except (KeyError, ET.ParseError):
        pass
    return sorted([n for n in zf.namelist() if n.startswith('Spreads/')])


def _load_metadata(zf):
    """Load embedded meet metadata from a custom story."""
    for name in zf.namelist():
        if name.startswith('Stories/') and name.endswith('.xml'):
            try:
                xml = zf.read(name).decode('utf-8')
                if 'CHP_METADATA' in xml:
                    root = ET.fromstring(xml)
                    for content in root.iter('Content'):
                        text = content.text or ''
                        if text.startswith('CHP_METADATA:'):
                            import json
                            return json.loads(text[len('CHP_METADATA:'):])
            except (ET.ParseError, ValueError):
                pass
    return {}


def _resolve_color(color_ref, colors):
    """Resolve a color reference to an RGB tuple or None."""
    if not color_ref or color_ref == 'Swatch/None':
        return None
    return colors.get(color_ref, (0, 0, 0))


def _load_object_styles(zf):
    """Load object style definitions from Resources/Styles.xml.

    Returns dict mapping style reference to its default attributes.
    """
    styles = {}
    try:
        xml = zf.read('Resources/Styles.xml').decode('utf-8')
        root = ET.fromstring(xml)
        for os_el in root.iter('ObjectStyle'):
            self_id = os_el.get('Self', '')
            name = os_el.get('Name', '')
            styles[f'ObjectStyle/{name}'] = {
                'StrokeColor': os_el.get('StrokeColor', ''),
                'FillColor': os_el.get('FillColor', ''),
                'StrokeWeight': os_el.get('StrokeWeight', ''),
            }
            if self_id:
                styles[self_id] = styles[f'ObjectStyle/{name}']
    except (KeyError, ET.ParseError):
        pass
    return styles


def _get_stroke_fill(element, colors, obj_styles=None):
    """Resolve fill, stroke, and stroke_w for an element.

    Falls back to the element's AppliedObjectStyle when attributes
    aren't explicitly set on the element itself.
    """
    fill_ref = element.get('FillColor', '')
    stroke_ref = element.get('StrokeColor', '')
    stroke_w_str = element.get('StrokeWeight', '')

    # Fall back to object style defaults
    if obj_styles and (not fill_ref or not stroke_ref or not stroke_w_str):
        style_ref = element.get('AppliedObjectStyle', '')
        style = obj_styles.get(style_ref)
        if style:
            if not fill_ref:
                fill_ref = style.get('FillColor', '')
            if not stroke_ref:
                stroke_ref = style.get('StrokeColor', '')
            if not stroke_w_str:
                stroke_w_str = style.get('StrokeWeight', '0')

    fill = _resolve_color(fill_ref, colors)
    stroke = _resolve_color(stroke_ref, colors)
    stroke_w = float(stroke_w_str) if stroke_w_str else 0

    return fill, stroke, stroke_w


def _has_curved_path(element):
    """Check if element's path has curved bezier control points (oval/circle)."""
    for ppt in element.iter('PathPointType'):
        anchor = ppt.get('Anchor', '').split()
        left = ppt.get('LeftDirection', '').split()
        if len(anchor) >= 2 and len(left) >= 2:
            if (abs(float(anchor[0]) - float(left[0])) > 0.1 or
                    abs(float(anchor[1]) - float(left[1])) > 0.1):
                return True
    return False


def _is_small_circle(bounds):
    """Check if bounds describe a small circle (8-16pt diameter)."""
    x1, y1, x2, y2 = bounds
    w, h = x2 - x1, y2 - y1
    return 6 < w < 16 and 6 < h < 16


def _align_circles_to_text(page, deferred_circles):
    """Draw deferred circles centered on nearby Bookman J characters.

    After all text is rendered, find the actual J positions and center
    each deferred circle on its nearest J.  Falls back to the original
    IDML position if no J is found nearby.
    """
    if not deferred_circles:
        return

    # Find all rendered J character positions
    j_rects = page.search_for("J")
    j_centers = [((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2) for r in j_rects]

    for bounds, stroke, stroke_w in deferred_circles:
        x1, y1, x2, y2 = bounds
        w, h = x2 - x1, y2 - y1
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2

        # Find nearest J within 15pt
        best_j = None
        best_dist = 15.0
        for jx, jy in j_centers:
            dist = ((cx - jx) ** 2 + (cy - jy) ** 2) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_j = (jx, jy)

        if best_j:
            # Center the circle on the J character
            jx, jy = best_j
            rect = fitz.Rect(jx - w / 2, jy - h / 2,
                             jx + w / 2, jy + h / 2)
        else:
            # No nearby J — use original IDML position
            rect = fitz.Rect(x1, y1, x2, y2)

        page.draw_oval(rect, fill=None, color=stroke, width=stroke_w)


# ---------------------------------------------------------------------------
# Spread renderer
# ---------------------------------------------------------------------------

def _render_spread(doc, spread_xml, stories, colors, zf, para_styles=None,
                   obj_styles=None):
    """Parse a Spread XML and render all elements to a new PDF page."""
    root = ET.fromstring(spread_xml)

    # Find the Spread element
    spread_el = root.find('.//{*}Spread')
    if spread_el is None:
        for child in root:
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'Spread':
                spread_el = child
                break
    if spread_el is None:
        spread_el = root

    # Auto-detect page dimensions from Page element's GeometricBounds
    _page_w, _page_h = PAGE_W, PAGE_H
    for child in spread_el:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag == 'Page':
            gb = child.get('GeometricBounds', '').split()
            if len(gb) == 4:
                _page_h = float(gb[2])
                _page_w = float(gb[3])
            break

    page = doc.new_page(width=_page_w, height=_page_h)
    page_offset = _get_page_offset(spread_el)

    # Collect small unfilled circles/ovals to defer until after text renders,
    # so we can center them on the actual J character positions.
    deferred_circles = []

    # Render all page items in document order (z-stacking)
    for child in spread_el:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag

        if tag in ('Page', 'FlattenerPreference'):
            continue

        # Skip off-page elements (pasteboard)
        bounds = _get_page_bounds(child, page_offset)
        if not _is_on_page(bounds, _page_w, _page_h):
            continue

        if tag == 'Rectangle':
            _draw_rectangle(page, child, colors, page_offset, zf)
        elif tag == 'Oval':
            # Defer small unfilled circles for J-text alignment
            if bounds and _is_small_circle(bounds):
                fill, stroke, stroke_w = _get_stroke_fill(
                    child, colors, obj_styles)
                if fill is None and stroke is not None and stroke_w > 0:
                    deferred_circles.append((bounds, stroke, stroke_w))
                    continue
            _draw_oval(page, child, colors, page_offset, obj_styles)
        elif tag == 'GraphicLine':
            _draw_line(page, child, colors, page_offset)
        elif tag == 'TextFrame':
            # Skip continuation frames (content rendered by the first frame)
            prev = child.get('PreviousTextFrame', 'n')
            if prev and prev != 'n':
                # Defer small circular-path text frames for J-text alignment
                if bounds and _is_small_circle(bounds) and \
                        _has_curved_path(child):
                    fill, stroke, stroke_w = _get_stroke_fill(
                        child, colors, obj_styles)
                    if stroke is not None and stroke_w > 0:
                        deferred_circles.append((bounds, stroke, stroke_w))
                        continue
                # Still draw frame border/fill if it has one
                _draw_text_frame_border(page, child, colors, page_offset,
                                        obj_styles)
                continue
            # Defer small circular-path text frames for J-text alignment
            if bounds and _is_small_circle(bounds) and \
                    _has_curved_path(child):
                fill, stroke, stroke_w = _get_stroke_fill(
                    child, colors, obj_styles)
                if stroke is not None and stroke_w > 0:
                    deferred_circles.append((bounds, stroke, stroke_w))
                    continue
            _draw_text_frame(page, child, stories, colors, page_offset,
                            para_styles, obj_styles)

    # Post-render: center deferred circles on actual Bookman J positions
    _align_circles_to_text(page, deferred_circles)


# ---------------------------------------------------------------------------
# Element renderers
# ---------------------------------------------------------------------------

def _draw_oval(page, element, colors, page_offset, obj_styles=None):
    """Draw a filled/stroked oval."""
    bounds = _get_page_bounds(element, page_offset)
    if not bounds:
        return
    fill, stroke, stroke_w = _get_stroke_fill(element, colors, obj_styles)

    # Skip invisible ovals
    if fill is None and (stroke is None or stroke_w <= 0):
        return

    rect = fitz.Rect(*bounds)
    page.draw_oval(rect, fill=fill,
                   color=stroke if stroke_w > 0 else None,
                   width=stroke_w if stroke_w > 0 else 0)


def _draw_line(page, element, colors, page_offset):
    """Draw a graphic line (solid or dashed)."""
    anchors = _get_page_anchors(element, page_offset)
    if len(anchors) < 2:
        return

    stroke_ref = element.get('StrokeColor', 'Color/Black')
    stroke = _resolve_color(stroke_ref, colors) or (0, 0, 0)
    stroke_w = float(element.get('StrokeWeight', '0.5'))
    stroke_type = element.get('StrokeType', '')

    if 'Dashed' in stroke_type:
        # Read actual dash pattern from IDML (e.g. "10 4" or "2 3")
        dash_gap = element.get('StrokeDashAndGap', '6 4')
        parts = dash_gap.split()
        if len(parts) >= 2:
            dash_str = f'[{parts[0]} {parts[1]}]'
        else:
            dash_str = '[6 4]'
        shape = page.new_shape()
        for i in range(len(anchors) - 1):
            shape.draw_line(fitz.Point(anchors[i]), fitz.Point(anchors[i + 1]))
        shape.finish(color=stroke, width=stroke_w, dashes=dash_str)
        shape.commit()
    else:
        for i in range(len(anchors) - 1):
            page.draw_line(fitz.Point(anchors[i]), fitz.Point(anchors[i + 1]),
                           color=stroke, width=stroke_w)


def _draw_rectangle(page, element, colors, page_offset, zf):
    """Draw a rectangle — either a visual shape or an image container."""
    # Check for child Image/PDF elements
    for sub in element:
        stag = sub.tag.split('}')[-1] if '}' in sub.tag else sub.tag
        if stag == 'Image':
            _draw_placed_image(page, element, sub, page_offset, zf)
            return
        elif stag == 'PDF':
            _draw_placed_pdf(page, element, sub, page_offset)
            return

    # Visual rectangle
    bounds = _get_page_bounds(element, page_offset)
    if not bounds:
        return

    fill_ref = element.get('FillColor', '')
    stroke_ref = element.get('StrokeColor', '')
    stroke_w_str = element.get('StrokeWeight', '')

    # Apply object style defaults for unset properties
    obj_style = element.get('AppliedObjectStyle', '')
    if not fill_ref:
        fill_ref = 'Swatch/None'
    if not stroke_ref:
        if 'Normal Graphics Frame' in obj_style:
            stroke_ref = 'Color/Black'
        else:
            stroke_ref = 'Swatch/None'
    stroke_w = float(stroke_w_str) if stroke_w_str else (
        1.0 if 'Normal Graphics Frame' in obj_style else 0.0)

    fill = _resolve_color(fill_ref, colors)
    stroke = _resolve_color(stroke_ref, colors)

    # Skip invisible rectangles
    if fill is None and (stroke is None or stroke_w <= 0):
        return

    transform = _parse_transform(element.get('ItemTransform', '1 0 0 1 0 0'))
    if _has_rotation(transform):
        # Draw as polygon from transformed anchor points
        anchors = _get_page_anchors(element, page_offset)
        if len(anchors) >= 3:
            points = [fitz.Point(a) for a in anchors]
            points.append(points[0])  # close
            shape = page.new_shape()
            shape.draw_polyline(points)
            shape.finish(fill=fill,
                         color=stroke if stroke_w > 0 else None,
                         width=stroke_w if stroke_w > 0 else 0)
            shape.commit()
    else:
        rect = fitz.Rect(*bounds)
        page.draw_rect(rect, fill=fill,
                       color=stroke if stroke_w > 0 else None,
                       width=stroke_w if stroke_w > 0 else 0)


# ---------------------------------------------------------------------------
# Image / PDF placement
# ---------------------------------------------------------------------------

def _draw_placed_image(page, container_el, image_el, page_offset, zf):
    """Draw a placed image (embedded TIF or external JPEG)."""
    bounds = _get_page_bounds(container_el, page_offset)
    if not bounds:
        return
    rect = fitz.Rect(*bounds)

    # Detect 180° flip from container transform (negative scale on both axes)
    tf = _parse_transform(container_el.get('ItemTransform', '1 0 0 1 0 0'))
    rotate = 180 if (tf[0] < 0 and tf[3] < 0) else 0

    link_el = image_el.find('.//Link')
    if link_el is None:
        return

    stored_state = link_el.get('StoredState', '')

    if stored_state == 'Embedded':
        # Extract base64 image data
        props = image_el.find('Properties')
        if props is None:
            return
        contents_el = None
        for p in props:
            ptag = p.tag.split('}')[-1] if '}' in p.tag else p.tag
            if ptag == 'Contents':
                contents_el = p
                break
        if contents_el is None or not contents_el.text:
            return
        try:
            image_data = base64.b64decode(contents_el.text)
            page.insert_image(rect, stream=image_data, rotate=rotate)
        except Exception:
            pass
    else:
        # External image — try to find the file
        uri = link_el.get('LinkResourceURI', '')
        filename = os.path.basename(unquote(uri))
        for search_dir in [_TEMPLATE_DIR, _LOGO_DIR, '.']:
            candidate = os.path.join(search_dir, filename)
            if os.path.exists(candidate):
                try:
                    page.insert_image(rect, filename=candidate, rotate=rotate)
                except Exception:
                    pass
                return


def _draw_placed_pdf(page, container_el, pdf_el, page_offset):
    """Draw a placed PDF (e.g., state logo)."""
    bounds = _get_page_bounds(container_el, page_offset)
    if not bounds:
        return

    link_el = pdf_el.find('.//Link')
    if link_el is None:
        return

    uri = link_el.get('LinkResourceURI', '')
    filename = os.path.basename(unquote(uri))

    # Compute clip from the PDF child's ItemTransform
    # The child transform maps source PDF coords → container local coords:
    #   container_x = scale * pdf_x + offset_x
    # We need the visible portion of the source PDF.
    local_bounds = _get_local_bounds(container_el)
    child_tf = _parse_transform(pdf_el.get('ItemTransform', '1 0 0 1 0 0'))
    clip_rect = None

    # Search for the PDF file
    for search_dir in [_LOGO_DIR, _TEMPLATE_DIR,
                       os.path.dirname(os.path.abspath(__file__)), '.']:
        candidate = os.path.join(search_dir, filename)
        if os.path.exists(candidate):
            try:
                logo_doc = fitz.open(candidate)
                target = fitz.Rect(*bounds)

                # Compute clip if we have transform data and local bounds
                if local_bounds and child_tf[0] != 0 and child_tf[3] != 0:
                    scale_x, scale_y = child_tf[0], child_tf[3]
                    off_x, off_y = child_tf[4], child_tf[5]
                    src_page = logo_doc[0].rect
                    # Map container local bounds back to source PDF coords
                    clip_x1 = max(0, (local_bounds[0] - off_x) / scale_x)
                    clip_y1 = max(0, (local_bounds[1] - off_y) / scale_y)
                    clip_x2 = min(src_page.width,
                                  (local_bounds[2] - off_x) / scale_x)
                    clip_y2 = min(src_page.height,
                                  (local_bounds[3] - off_y) / scale_y)
                    clip_rect = fitz.Rect(clip_x1, clip_y1, clip_x2, clip_y2)

                if clip_rect and not clip_rect.is_empty:
                    page.show_pdf_page(target, logo_doc, 0, clip=clip_rect)
                else:
                    page.show_pdf_page(target, logo_doc, 0)
                logo_doc.close()
            except Exception:
                pass
            return


# ---------------------------------------------------------------------------
# Text frame renderer
# ---------------------------------------------------------------------------

def _draw_text_frame_border(page, element, colors, page_offset,
                            obj_styles=None):
    """Draw only the border/fill of a text frame (no text content)."""
    fill, stroke, stroke_w = _get_stroke_fill(element, colors, obj_styles)
    if fill is not None or (stroke is not None and stroke_w > 0):
        transform = _parse_transform(element.get('ItemTransform', '1 0 0 1 0 0'))
        page_bounds = _get_page_bounds(element, page_offset)
        if page_bounds:
            if _has_curved_path(element):
                # Circular/oval-shaped text frame — draw as oval
                page.draw_oval(fitz.Rect(*page_bounds), fill=fill,
                               color=stroke if stroke_w > 0 else None,
                               width=stroke_w if stroke_w > 0 else 0)
            elif _has_rotation(transform):
                anchors = _get_page_anchors(element, page_offset)
                if len(anchors) >= 3:
                    pts = [fitz.Point(a) for a in anchors]
                    pts.append(pts[0])
                    shape = page.new_shape()
                    shape.draw_polyline(pts)
                    shape.finish(fill=fill,
                                 color=stroke if stroke_w > 0 else None,
                                 width=stroke_w if stroke_w > 0 else 0)
                    shape.commit()
            else:
                page.draw_rect(fitz.Rect(*page_bounds), fill=fill,
                               color=stroke if stroke_w > 0 else None,
                               width=stroke_w if stroke_w > 0 else 0)


def _draw_text_frame(page, element, stories, colors, page_offset,
                     para_styles=None, obj_styles=None):
    """Draw a text frame's content, handling rotation and frame styling."""
    story_id = element.get('ParentStory', '')
    story = stories.get(story_id)
    if story is None:
        # Still draw frame border (e.g. circular-path frames with no story)
        _draw_text_frame_border(page, element, colors, page_offset, obj_styles)
        return

    paragraphs = _parse_story(story, colors, para_styles)
    if not paragraphs:
        # Still draw frame border (e.g. empty story with visible stroke)
        _draw_text_frame_border(page, element, colors, page_offset, obj_styles)
        return

    transform = _parse_transform(element.get('ItemTransform', '1 0 0 1 0 0'))

    # Get frame bounds in local coordinates (for layout calculations)
    local_bounds = _get_local_bounds(element)
    if not local_bounds:
        return
    lx1, ly1, lx2, ly2 = local_bounds
    frame_w = lx2 - lx1
    frame_h = ly2 - ly1
    local_cx = (lx1 + lx2) / 2

    # Vertical justification
    tfp = element.find('.//TextFramePreference')
    v_just = 'TopAlign'
    if tfp is not None:
        v_just = tfp.get('VerticalJustification', 'TopAlign')

    # Word-wrap paragraphs that exceed the frame width, producing "lines"
    # Each line is a dict with 'segments' and 'align' (same shape as a para).
    lines = []
    for para in paragraphs:
        wrapped = _wrap_paragraph(para, frame_w)
        lines.extend(wrapped)

    # Calculate line heights (leading): use explicit leading if available,
    # otherwise fall back to InDesign's default auto-leading (120%)
    line_heights = []
    for line in lines:
        max_size = max((seg['size'] for seg in line['segments']), default=9)
        # Check for explicit leading on any segment in this line
        explicit_leading = None
        for seg in line['segments']:
            seg_leading = seg.get('leading')
            if seg_leading is not None:
                if explicit_leading is None or seg_leading > explicit_leading:
                    explicit_leading = seg_leading
        lh = explicit_leading if explicit_leading is not None else max_size * 1.2
        line_heights.append(lh)

    # First baseline offset: AscentOffset (InDesign default)
    # The first baseline sits at frame_top + font_ascent (not a full leading unit)
    # For Times New Roman, the AFM Ascender = 683/1000 of em square.
    first_size = max((seg['size'] for seg in lines[0]['segments']), default=9)
    first_fitz_name = lines[0]['segments'][0]['font'] if lines[0]['segments'] else 'Times-Roman'
    first_font_file = lines[0]['segments'][0].get('font_file') if lines[0]['segments'] else None
    font_obj = _get_font_obj(first_fitz_name, first_font_file)
    cap_rect = font_obj.glyph_bbox(ord('d'))
    ascent_ratio = (cap_rect.y1 + 0.007) if cap_rect and cap_rect.y1 > 0 else 0.683
    first_ascent = first_size * ascent_ratio

    # Total text height: first_ascent + sum of leading for lines 1..n
    total_text_h = first_ascent
    for i in range(1, len(lines)):
        total_text_h += line_heights[i]

    # Starting Y based on vertical justification (no auto-scaling — InDesign clips overflow)
    if v_just == 'CenterAlign':
        start_y = ly1 + (frame_h - min(total_text_h, frame_h)) / 2
    else:
        start_y = ly1

    # Draw frame background/border if specified
    _draw_text_frame_border(page, element, colors, page_offset, obj_styles)

    # Rotation setup
    has_rot = _has_rotation(transform)
    angle = _rotation_angle(transform) if has_rot else 0
    # Frame center in page coordinates (pivot for rotation)
    if has_rot:
        spread_cx, spread_cy = _apply_transform(
            local_cx, (ly1 + ly2) / 2, transform)
        pivot = fitz.Point(spread_cx - page_offset[0],
                           spread_cy - page_offset[1])
        # Negate angle: PyMuPDF morph rotates in PDF coords (Y-up),
        # but page coords are Y-down, so we negate to compensate.
        rot_matrix = fitz.Matrix(-angle)

    # Compute baseline positions for each line
    baselines = []
    y = start_y + first_ascent  # first baseline (AscentOffset)
    baselines.append(y)
    for i in range(1, len(lines)):
        y += line_heights[i]
        baselines.append(y)

    # Draw each line (wrapped paragraph), clipping to frame bounds
    for i, para in enumerate(lines):
        baseline_y = baselines[i]

        # Skip lines that fall outside the frame (text frame clipping)
        if baseline_y > ly2 + 2:  # small tolerance for descenders
            break  # all subsequent lines will also be outside

        # Calculate segment widths for alignment
        seg_widths = []
        total_w = 0
        for seg in para['segments']:
            w = _seg_width(seg)
            seg_widths.append(w)
            total_w += w

        align = para.get('align', 'CenterAlign')
        line_left_indent = para.get('left_indent', 0)
        line_first_indent = para.get('first_line_indent', 0)
        effective_indent = line_left_indent + line_first_indent

        if align == 'CenterAlign':
            draw_x = local_cx - total_w / 2
        elif align == 'RightAlign':
            draw_x = lx2 - total_w
        else:
            draw_x = lx1 + effective_indent

        # Draw each segment
        for j, seg in enumerate(para['segments']):
            color = seg.get('color', (0, 0, 0))
            seg_w = seg_widths[j]
            is_sc = seg.get('smallcaps', False)
            h_scale = seg.get('h_scale', 100) / 100

            if has_rot:
                dx = draw_x - local_cx
                dy = baseline_y - (ly1 + ly2) / 2
                insert_pt = fitz.Point(pivot.x + dx, pivot.y + dy)
                rot_morph = (pivot, rot_matrix)
                if is_sc:
                    # SmallCaps handles h_scale internally per-character;
                    # pass only rotation morph to avoid double-scaling
                    _render_smallcaps(page, insert_pt, seg['text'],
                                     seg['font'], seg['font_file'],
                                     seg['size'], color=color,
                                     morph=rot_morph, h_scale=h_scale)
                else:
                    # Combine rotation with horizontal scaling for regular text
                    if h_scale != 1.0:
                        combined = rot_matrix * fitz.Matrix(h_scale, 1.0)
                        morph_arg = (pivot, combined)
                    else:
                        morph_arg = rot_morph
                    _insert_text(page, insert_pt, seg['text'],
                                 seg['font'], seg['font_file'], seg['size'],
                                 color=color, morph=morph_arg)
            else:
                sx, sy = _apply_transform(draw_x, baseline_y, transform)
                px = sx - page_offset[0]
                py = sy - page_offset[1]

                if is_sc:
                    # SmallCaps handles h_scale internally per-character;
                    # no caller morph needed
                    _render_smallcaps(page, fitz.Point(px, py), seg['text'],
                                     seg['font'], seg['font_file'],
                                     seg['size'], color=color,
                                     h_scale=h_scale)
                else:
                    # Apply horizontal scaling via morph for regular text
                    morph_arg = None
                    if h_scale != 1.0:
                        morph_arg = (fitz.Point(px, py),
                                     fitz.Matrix(h_scale, 1.0))
                    _insert_text(page, fitz.Point(px, py), seg['text'],
                                 seg['font'], seg['font_file'], seg['size'],
                                 color=color, morph=morph_arg)

                # Draw underline if flagged
                if seg.get('underline'):
                    ul_y = py + seg['size'] * 0.15
                    ul_w = max(0.5, seg['size'] / 14)
                    page.draw_line(fitz.Point(px, ul_y),
                                   fitz.Point(px + seg_w, ul_y),
                                   color=color, width=ul_w)

            draw_x += seg_w


# ---------------------------------------------------------------------------
# Text wrapping
# ---------------------------------------------------------------------------

def _wrap_paragraph(para, frame_w):
    """Word-wrap a paragraph into multiple lines that fit within frame_w.

    Returns a list of line dicts, each with 'segments', 'align', and indent info.
    Handles SmallCaps segments correctly by keeping them intact per-word.
    Handles tab characters via InDesign-style tab stops (36pt intervals).
    Tab characters affect wrapping but are stripped from rendered output.
    """
    align = para.get('align', 'CenterAlign')
    left_indent = para.get('left_indent', 0)
    first_line_indent = para.get('first_line_indent', 0)

    # Available widths: first line vs subsequent lines
    first_line_w = frame_w - left_indent - first_line_indent
    other_lines_w = frame_w - left_indent

    # Check for tab characters — need position-aware wrapping
    has_tabs = any('\t' in seg['text'] for seg in para['segments'])

    if not has_tabs:
        # ---- Fast path: no tabs, use simple width comparison ----
        total_w = sum(_seg_width(seg) for seg in para['segments'])
        if total_w <= first_line_w or frame_w <= 0:
            return [para]

        # Flatten all segments into word-level entries
        words = []
        for seg in para['segments']:
            parts = seg['text'].split(' ')
            for k, part in enumerate(parts):
                word = part if k == 0 else ' ' + part
                if not word:
                    continue
                words.append({
                    'text': word,
                    'font': seg['font'],
                    'font_file': seg['font_file'],
                    'size': seg['size'],
                    'color': seg['color'],
                    'underline': seg.get('underline', False),
                    'smallcaps': seg.get('smallcaps', False),
                    'h_scale': seg.get('h_scale', 100),
                    'leading': seg.get('leading'),
                })

        # Build lines by accumulating words
        lines = []
        current_segs = []
        current_w = 0
        is_first_line = True

        for word_seg in words:
            w = _seg_width(word_seg)
            max_w = first_line_w if is_first_line else other_lines_w

            if current_segs and current_w + w > max_w:
                lines.append({
                    'segments': current_segs, 'align': align,
                    'left_indent': left_indent,
                    'first_line_indent': first_line_indent if is_first_line else 0,
                })
                is_first_line = False
                text = word_seg['text'].lstrip(' ')
                new_seg = {**word_seg, 'text': text}
                current_segs = [new_seg]
                current_w = _seg_width(new_seg)
            else:
                current_segs.append(word_seg)
                current_w += w

        if current_segs:
            lines.append({
                'segments': current_segs, 'align': align,
                'left_indent': left_indent,
                'first_line_indent': first_line_indent if is_first_line else 0,
            })

        return lines

    # ---- Tab-aware wrapping ----
    # Tokenize segments into (type, data, props) tuples.
    # Types: 'word' (renderable text), 'space', 'tab' (position advance only)
    tokens = []
    last_props = None
    for seg in para['segments']:
        props = {k: v for k, v in seg.items() if k != 'text'}
        last_props = props
        text = seg['text']
        # Split on tab boundaries
        tab_parts = text.split('\t')
        for ti, part in enumerate(tab_parts):
            if ti > 0:
                tokens.append(('tab', None, props))
            if part:
                # Split on spaces for word-level wrapping
                space_parts = part.split(' ')
                for si, word in enumerate(space_parts):
                    if si > 0:
                        tokens.append(('space', ' ', props))
                    if word:
                        tokens.append(('word', word, props))

    def _mk_line(segs, first):
        if not segs and last_props:
            segs = [{**last_props, 'text': ''}]
        return {
            'segments': segs, 'align': align,
            'left_indent': left_indent,
            'first_line_indent': first_line_indent if first else 0,
        }

    lines = []
    current_segs = []
    is_first = True
    # Absolute cursor position from frame left edge
    cursor = left_indent + first_line_indent
    line_has_content = False

    for ttype, tdata, props in tokens:
        if ttype == 'tab':
            next_stop = _next_tab_stop(cursor)
            if next_stop > frame_w:
                # Tab exceeds frame width — wrap line
                lines.append(_mk_line(current_segs, is_first))
                is_first = False
                current_segs = []
                cursor = left_indent
                line_has_content = False
                next_stop = _next_tab_stop(cursor)
            # Insert a spacer segment to represent the tab position advance.
            # The renderer will advance draw_x by _tab_width, preserving
            # InDesign's tab stop alignment in the output PDF.
            gap = next_stop - cursor
            if gap > 0:
                current_segs.append({
                    **props, 'text': '', '_tab_width': gap,
                    'underline': False,
                })
            cursor = next_stop
            line_has_content = True

        elif ttype == 'space':
            w = _seg_width({**props, 'text': ' '})
            current_segs.append({**props, 'text': ' '})
            cursor += w
            line_has_content = True

        elif ttype == 'word':
            w = _seg_width({**props, 'text': tdata})
            if (current_segs or line_has_content) and cursor + w > frame_w:
                lines.append(_mk_line(current_segs, is_first))
                is_first = False
                current_segs = [{**props, 'text': tdata}]
                cursor = left_indent + w
                line_has_content = True
            else:
                current_segs.append({**props, 'text': tdata})
                cursor += w
                line_has_content = True

    if current_segs or line_has_content:
        lines.append(_mk_line(current_segs, is_first))

    return lines if lines else [para]


# ---------------------------------------------------------------------------
# Story parser
# ---------------------------------------------------------------------------

_SMALLCAPS_SCALE = 0.70


def _smallcaps_text_width(text, base_size, fitz_name, font_file):
    """Measure the width of SmallCaps text character-by-character.

    Lowercase letters → uppercase glyphs at 70% of base_size.
    Uppercase letters and spaces → full base_size.
    Digits/punctuation → inherit context of preceding alpha character.
    """
    font = _get_font_obj(fitz_name, font_file)
    total = 0
    in_lower_ctx = False  # tracks whether we're in a lowercase context
    for ch in text:
        if ch.isalpha():
            if ch.islower():
                in_lower_ctx = True
                total += font.text_length(ch.upper(), fontsize=base_size * _SMALLCAPS_SCALE)
            else:
                in_lower_ctx = False
                total += font.text_length(ch, fontsize=base_size)
        elif ch == ' ':
            # Spaces always full size for readable word spacing
            total += font.text_length(' ', fontsize=base_size)
        else:
            # Digits, punctuation inherit context
            sz = base_size * _SMALLCAPS_SCALE if in_lower_ctx else base_size
            total += font.text_length(ch, fontsize=sz)
    return total


def _render_smallcaps(page, point, text, fitz_name, font_file, base_size,
                      color=(0, 0, 0), morph=None, h_scale=1.0):
    """Render SmallCaps text character-by-character at the correct sizes.

    h_scale: horizontal scaling factor (0.8 = 80% width).
    Returns the total width rendered (for underline/advance calculations).
    """
    font = _get_font_obj(fitz_name, font_file)
    x = point.x
    y = point.y
    in_lower_ctx = False
    for ch in text:
        if ch.isalpha():
            if ch.islower():
                in_lower_ctx = True
                out_ch = ch.upper()
                sz = base_size * _SMALLCAPS_SCALE
            else:
                in_lower_ctx = False
                out_ch = ch
                sz = base_size
        elif ch == ' ':
            out_ch = ' '
            sz = base_size
        else:
            out_ch = ch
            sz = base_size * _SMALLCAPS_SCALE if in_lower_ctx else base_size

        # Apply horizontal scaling via morph if needed
        if h_scale != 1.0 and morph is None:
            char_morph = (fitz.Point(x, y), fitz.Matrix(h_scale, 1.0))
        elif h_scale != 1.0 and morph is not None:
            # Combine existing rotation morph with horizontal scaling
            pivot, rot_mat = morph
            char_morph = (pivot, rot_mat * fitz.Matrix(h_scale, 1.0))
        else:
            char_morph = morph

        _insert_text(page, fitz.Point(x, y), out_ch, fitz_name, font_file,
                     sz, color=color, morph=char_morph)
        x += font.text_length(out_ch, fontsize=sz) * h_scale
    return x - point.x


def _seg_width(seg):
    """Measure a segment's width, handling SmallCaps, HorizontalScale, and tab spacers."""
    # Tab spacer segments have a pre-calculated width (from _wrap_paragraph)
    if '_tab_width' in seg:
        return seg['_tab_width']
    h_scale = seg.get('h_scale', 100) / 100
    if seg.get('smallcaps'):
        return _smallcaps_text_width(seg['text'], seg['size'], seg['font'],
                                     seg['font_file']) * h_scale
    return _text_width(seg['text'], seg['font'], seg['font_file'], seg['size']) * h_scale


def _parse_story(story_el, colors, para_styles=None):
    """Parse a Story element into a list of paragraphs.

    Each paragraph: {'segments': [...], 'align': str,
                     'left_indent': float, 'first_line_indent': float,
                     'space_before': float, 'space_after': float}
    Each segment: {'text': str, 'font': str, 'font_file': str|None,
                   'size': float, 'color': tuple, 'underline': bool,
                   'h_scale': float}

    Handles Capitalization (SmallCaps, AllCaps), Underline, HorizontalScale.
    """
    paragraphs = []
    para_styles = para_styles or {}

    for psr in story_el.iter('ParagraphStyleRange'):
        style = psr.get('AppliedParagraphStyle', '')
        align = psr.get('Justification', '')

        # Look up paragraph style for defaults
        style_def = para_styles.get(style, {})
        left_indent = float(psr.get('LeftIndent', style_def.get('left_indent', 0)))
        first_line_indent = float(psr.get('FirstLineIndent',
                                          style_def.get('first_line_indent', 0)))
        space_before = float(psr.get('SpaceBefore',
                                     style_def.get('space_before', 0)))
        space_after = float(psr.get('SpaceAfter',
                                    style_def.get('space_after', 0)))

        if not align:
            # Try style definition first
            align = style_def.get('justification', '')
        if not align:
            if any(kw in style for kw in ('Title', 'Copyright', 'Label',
                                          'Divider', 'Headers', 'WinnerName',
                                          'Center')):
                align = 'CenterAlign'
            elif 'Right' in style:
                align = 'RightAlign'
            elif 'Left' in style:
                align = 'LeftAlign'
            else:
                # Default to LeftAlign (matches InDesign's default paragraph style)
                align = 'LeftAlign'

        segments = []

        # Default PointSize/FontStyle from paragraph style (fallback 12pt)
        default_size = style_def.get('point_size', 12) or 12
        default_font_style = style_def.get('font_style', 'Regular') or 'Regular'

        for csr in psr.findall('CharacterStyleRange'):
            size = float(csr.get('PointSize', '') or default_size)
            font_style = csr.get('FontStyle', '') or default_font_style
            capitalization = csr.get('Capitalization', '')
            underline = csr.get('Underline', '') == 'true'
            h_scale = float(csr.get('HorizontalScale', '100'))

            font_family = 'Times New Roman'
            leading = None  # None = auto-leading (120%)
            props = csr.find('Properties')
            if props is not None:
                af = props.find('AppliedFont')
                if af is not None and af.text:
                    font_family = af.text
                ld = props.find('Leading')
                if ld is not None and ld.text:
                    try:
                        leading = float(ld.text)
                    except (ValueError, TypeError):
                        pass

            fitz_name, font_file = _resolve_font(font_family, font_style)

            fill_ref = csr.get('FillColor', '')
            color = _resolve_color(fill_ref, colors) if fill_ref else (0, 0, 0)

            for child in csr:
                tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                if tag == 'Content':
                    text = child.text or ''
                    if text:
                        # Map Unicode typographic chars to ASCII for base14 fonts
                        for uc, ac in _CHAR_MAP.items():
                            if uc in text:
                                text = text.replace(uc, ac)

                        # Split on newlines (from \u2028 line separator)
                        parts = text.split('\n')
                        for pi, part in enumerate(parts):
                            if pi > 0:
                                # Line break — flush current segments
                                if segments:
                                    paragraphs.append({
                                        'segments': segments,
                                        'align': align,
                                        'left_indent': left_indent,
                                        'first_line_indent': first_line_indent,
                                        'space_before': space_before,
                                        'space_after': space_after,
                                    })
                                    segments = []
                            if not part:
                                continue
                            if capitalization == 'SmallCaps':
                                segments.append({
                                    'text': part,
                                    'font': fitz_name,
                                    'font_file': font_file,
                                    'size': size,
                                    'color': color,
                                    'underline': underline,
                                    'smallcaps': True,
                                    'h_scale': h_scale,
                                    'leading': leading,
                                })
                            else:
                                t = part.upper() if capitalization == 'AllCaps' else part
                                segments.append({
                                    'text': t,
                                    'font': fitz_name,
                                    'font_file': font_file,
                                    'size': size,
                                    'color': color,
                                    'underline': underline,
                                    'h_scale': h_scale,
                                    'leading': leading,
                                })
                elif tag == 'Br':
                    if segments:
                        paragraphs.append({
                            'segments': segments,
                            'align': align,
                            'left_indent': left_indent,
                            'first_line_indent': first_line_indent,
                            'space_before': space_before,
                            'space_after': space_after,
                        })
                        segments = []
                    else:
                        # Empty paragraph (blank line) — preserve with a
                        # zero-width segment carrying the correct size/leading
                        paragraphs.append({
                            'segments': [{
                                'text': '',
                                'font': fitz_name,
                                'font_file': font_file,
                                'size': size,
                                'color': (0, 0, 0),
                                'underline': False,
                                'h_scale': 100,
                                'leading': leading,
                            }],
                            'align': align,
                            'left_indent': left_indent,
                            'first_line_indent': first_line_indent,
                            'space_before': space_before,
                            'space_after': space_after,
                        })

        if segments:
            paragraphs.append({
                'segments': segments,
                'align': align,
                'left_indent': left_indent,
                'first_line_indent': first_line_indent,
                'space_before': space_before,
                'space_after': space_after,
            })

    return paragraphs


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def idml_to_pdf(idml_path: str, output_pdf_path: str) -> dict:
    """Convert an IDML file to a PDF.

    Returns dict with metadata if embedded, otherwise empty dict.
    """
    with zipfile.ZipFile(idml_path, 'r') as zf:
        colors = _load_colors(zf)
        stories = _load_stories(zf)
        spread_files = _get_spread_files(zf)
        metadata = _load_metadata(zf)
        para_styles = _load_paragraph_styles(zf)
        obj_styles = _load_object_styles(zf)

        doc = fitz.open()
        for spread_file in spread_files:
            spread_xml = zf.read(spread_file).decode('utf-8')
            _render_spread(doc, spread_xml, stories, colors, zf, para_styles,
                           obj_styles)

        # Capture page dimensions from the first rendered page
        if len(doc) > 0:
            metadata['page_w'] = doc[0].rect.width
            metadata['page_h'] = doc[0].rect.height

        doc.save(output_pdf_path)
        doc.close()

    return metadata
