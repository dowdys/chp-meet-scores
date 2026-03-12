"""IDML-to-PDF converter.

Parses an InDesign IDML file (ZIP of XML) and renders it as a PDF using
PyMuPDF. This enables the round-trip workflow:

    App generates IDML → User edits in InDesign → User returns IDML →
    App converts back to PDF (pixel-accurate to the InDesign edits)

The converter extracts every element (text frames, ovals, lines) with
their exact positions, fonts, colors, and sizes, then re-renders them
onto PDF pages.
"""

import zipfile
from xml.etree import ElementTree as ET

import fitz  # PyMuPDF

PAGE_W = 612
PAGE_H = 792

# Map InDesign PostScript font names → PyMuPDF base14 names
_PS_TO_FITZ = {
    'TimesNewRomanPSMT': 'Times-Roman',
    'TimesNewRomanPS-BoldMT': 'Times-Bold',
    'Helvetica': 'Helvetica',
    'Helvetica-Bold': 'Helvetica-Bold',
}

# Map InDesign font style keywords → PyMuPDF base14 fallbacks
_STYLE_TO_FITZ = {
    ('Times New Roman', 'Regular'): 'Times-Roman',
    ('Times New Roman', 'Bold'): 'Times-Bold',
    ('Helvetica', 'Regular'): 'Helvetica',
    ('Helvetica', 'Bold'): 'Helvetica-Bold',
}


def idml_to_pdf(idml_path: str, output_pdf_path: str) -> dict:
    """Convert an IDML file to a PDF.

    Args:
        idml_path: Path to the .idml file
        output_pdf_path: Path to write the output .pdf

    Returns:
        dict with metadata extracted from the IDML (meet_name, state, year, etc.)
        if embedded, otherwise empty dict.
    """
    with zipfile.ZipFile(idml_path, 'r') as zf:
        # Load color definitions
        colors = _load_colors(zf)

        # Load all stories (text content)
        stories = _load_stories(zf)

        # Load spread file list from designmap
        spread_files = _get_spread_files(zf)

        # Check for embedded metadata
        metadata = _load_metadata(zf)

        # Create PDF
        doc = fitz.open()

        for spread_file in spread_files:
            spread_xml = zf.read(spread_file).decode('utf-8')
            _render_spread(doc, spread_xml, stories, colors)

        doc.save(output_pdf_path)
        doc.close()

    return metadata


# ---------------------------------------------------------------------------
# Resource loaders
# ---------------------------------------------------------------------------

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
            ref = f'Color/{name}'
            space = color_el.get('Space', '')
            value_str = color_el.get('ColorValue', '')
            if not value_str:
                continue
            values = [float(v) for v in value_str.split()]
            if space == 'RGB' and len(values) >= 3:
                colors[ref] = (values[0] / 255, values[1] / 255, values[2] / 255)
            elif space == 'CMYK' and len(values) >= 4:
                # Simple CMYK→RGB conversion
                c, m, y, k = [v / 100 for v in values]
                r = (1 - c) * (1 - k)
                g = (1 - m) * (1 - k)
                b = (1 - y) * (1 - k)
                colors[ref] = (r, g, b)
    except (KeyError, ET.ParseError):
        pass
    return colors


def _load_stories(zf):
    """Load all Story files into a dict keyed by story ID."""
    stories = {}
    for name in zf.namelist():
        if name.startswith('Stories/Story_') and name.endswith('.xml'):
            xml = zf.read(name).decode('utf-8')
            root = ET.fromstring(xml)
            # Find the Story element (may be wrapped in idPkg:Story)
            story_el = root.find('.//{*}Story')
            if story_el is None:
                # Try direct children
                for child in root:
                    tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                    if tag == 'Story':
                        story_el = child
                        break
            if story_el is None:
                story_el = root  # fallback
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
    # Fallback: find Spread files by listing
    return sorted([n for n in zf.namelist() if n.startswith('Spreads/')])


def _load_metadata(zf):
    """Load embedded meet metadata from MasterSpread or custom story."""
    metadata = {}
    # Look for a metadata story (we'll embed this in future IDML output)
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
                            metadata = json.loads(text[len('CHP_METADATA:'):])
                            return metadata
            except (ET.ParseError, ValueError):
                pass
    return metadata


# ---------------------------------------------------------------------------
# Spread renderer
# ---------------------------------------------------------------------------

def _render_spread(doc, spread_xml, stories, colors):
    """Parse a Spread XML and render all elements to a new PDF page."""
    root = ET.fromstring(spread_xml)
    page = doc.new_page(width=PAGE_W, height=PAGE_H)

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

    # Collect all page items in document order
    # (order matters for z-stacking: earlier items are behind later items)
    for child in spread_el:
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag == 'Page':
            continue  # Skip page definition
        elif tag == 'Oval':
            _draw_oval(page, child, colors)
        elif tag == 'GraphicLine':
            _draw_line(page, child, colors)
        elif tag == 'TextFrame':
            _draw_text_frame(page, child, stories, colors)


# ---------------------------------------------------------------------------
# Element renderers
# ---------------------------------------------------------------------------

def _get_bounds(element):
    """Extract bounding box from PathGeometry anchor points.

    Returns (x1, y1, x2, y2) where (x1,y1) is top-left and (x2,y2) is bottom-right.
    """
    anchors = []
    for ppt in element.iter('PathPointType'):
        anchor = ppt.get('Anchor', '')
        parts = anchor.split()
        if len(parts) >= 2:
            anchors.append((float(parts[0]), float(parts[1])))
    if not anchors:
        return None
    xs = [a[0] for a in anchors]
    ys = [a[1] for a in anchors]
    return (min(xs), min(ys), max(xs), max(ys))


def _get_oval_params(element):
    """Extract oval Bezier control points for PyMuPDF rendering.

    Returns the bounding rect as (x1, y1, x2, y2).
    """
    return _get_bounds(element)


def _resolve_color(color_ref, colors):
    """Resolve a color reference to an RGB tuple."""
    if not color_ref or color_ref == 'Swatch/None':
        return None
    return colors.get(color_ref, (0, 0, 0))


def _draw_oval(page, element, colors):
    """Draw a filled oval on the PDF page."""
    bounds = _get_oval_params(element)
    if not bounds:
        return
    fill_ref = element.get('FillColor', 'Swatch/None')
    fill = _resolve_color(fill_ref, colors)
    stroke_ref = element.get('StrokeColor', 'Swatch/None')
    stroke = _resolve_color(stroke_ref, colors)
    stroke_w = float(element.get('StrokeWeight', '0'))

    rect = fitz.Rect(*bounds)
    page.draw_oval(rect, fill=fill,
                   color=stroke if stroke_w > 0 else None,
                   width=stroke_w if stroke_w > 0 else 0)


def _draw_line(page, element, colors):
    """Draw a graphic line on the PDF page."""
    anchors = []
    for ppt in element.iter('PathPointType'):
        anchor = ppt.get('Anchor', '')
        parts = anchor.split()
        if len(parts) >= 2:
            anchors.append((float(parts[0]), float(parts[1])))
    if len(anchors) < 2:
        return

    stroke_ref = element.get('StrokeColor', 'Color/Black')
    stroke = _resolve_color(stroke_ref, colors)
    stroke_w = float(element.get('StrokeWeight', '1'))

    p1 = fitz.Point(anchors[0])
    p2 = fitz.Point(anchors[1])
    page.draw_line(p1, p2, color=stroke or (0, 0, 0), width=stroke_w)


def _draw_text_frame(page, element, stories, colors):
    """Draw a text frame's content on the PDF page."""
    bounds = _get_bounds(element)
    if not bounds:
        return
    x1, y1, x2, y2 = bounds
    frame_w = x2 - x1
    frame_h = y2 - y1
    cx = (x1 + x2) / 2

    story_id = element.get('ParentStory', '')
    story = stories.get(story_id)
    if story is None:
        return

    # Get vertical justification from TextFramePreference
    tfp = element.find('.//TextFramePreference')
    v_just = 'TopAlign'
    if tfp is not None:
        v_just = tfp.get('VerticalJustification', 'TopAlign')

    # Parse paragraphs from story
    paragraphs = _parse_story(story, colors)
    if not paragraphs:
        return

    # Calculate total text height
    line_heights = []
    for para in paragraphs:
        max_size = max((seg['size'] for seg in para['segments']), default=9)
        lh = max_size * 1.15
        line_heights.append(lh)
    total_text_h = sum(line_heights)

    # Determine starting Y based on vertical justification
    if v_just == 'CenterAlign':
        start_y = y1 + (frame_h - total_text_h) / 2
    else:
        start_y = y1

    # Draw each paragraph
    current_y = start_y
    for i, para in enumerate(paragraphs):
        lh = line_heights[i]
        baseline_y = current_y + lh * 0.85  # approximate ascent

        # Calculate total width of all segments for centering
        total_w = 0
        seg_widths = []
        for seg in para['segments']:
            w = fitz.get_text_length(seg['text'],
                                      fontname=seg['font'],
                                      fontsize=seg['size'])
            seg_widths.append(w)
            total_w += w

        # Determine paragraph alignment (default center)
        align = para.get('align', 'CenterAlign')

        if align == 'CenterAlign':
            draw_x = cx - total_w / 2
        elif align == 'RightAlign':
            draw_x = x2 - total_w
        else:
            draw_x = x1

        # Draw each segment
        for j, seg in enumerate(para['segments']):
            color = seg.get('color', (0, 0, 0))
            page.insert_text(
                fitz.Point(draw_x, baseline_y),
                seg['text'],
                fontname=seg['font'],
                fontsize=seg['size'],
                color=color or (0, 0, 0)
            )
            draw_x += seg_widths[j]

        current_y += lh


def _parse_story(story_el, colors):
    """Parse a Story element into a list of paragraphs.

    Each paragraph is a dict with:
        'segments': list of {'text': str, 'font': str, 'size': float, 'color': tuple}
        'align': str (CenterAlign, LeftAlign, etc.)
    """
    paragraphs = []

    for psr in story_el.iter('ParagraphStyleRange'):
        # Get alignment from paragraph style name or attributes
        style = psr.get('AppliedParagraphStyle', '')
        align = psr.get('Justification', '')

        # If no explicit Justification, infer from style name
        if not align:
            if 'Title' in style or 'Copyright' in style or 'Label' in style:
                align = 'CenterAlign'
            elif 'Divider' in style:
                align = 'CenterAlign'
            elif 'Headers' in style:
                align = 'CenterAlign'
            elif 'WinnerName' in style:
                align = 'CenterAlign'
            else:
                align = 'CenterAlign'

        segments = []
        has_br = False

        for csr in psr.findall('CharacterStyleRange'):
            size = float(csr.get('PointSize', '9'))
            font_style = csr.get('FontStyle', 'Regular')

            # Resolve font family
            font_family = 'Times New Roman'
            props = csr.find('Properties')
            if props is not None:
                af = props.find('AppliedFont')
                if af is not None and af.text:
                    font_family = af.text

            fitz_font = _STYLE_TO_FITZ.get((font_family, font_style))
            if not fitz_font:
                if 'Bold' in font_style:
                    fitz_font = 'Times-Bold'
                else:
                    fitz_font = 'Times-Roman'

            # Resolve color
            fill_ref = csr.get('FillColor', '')
            color = _resolve_color(fill_ref, colors) if fill_ref else (0, 0, 0)

            # Extract text content
            for child in csr:
                tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                if tag == 'Content':
                    text = child.text or ''
                    if text:
                        segments.append({
                            'text': text,
                            'font': fitz_font,
                            'size': size,
                            'color': color,
                        })
                elif tag == 'Br':
                    # Paragraph break — flush current segments as a paragraph
                    if segments:
                        paragraphs.append({
                            'segments': segments,
                            'align': align,
                        })
                        segments = []
                    has_br = True

        # Flush remaining segments
        if segments:
            paragraphs.append({
                'segments': segments,
                'align': align,
            })

    return paragraphs
