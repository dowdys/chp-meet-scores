"""ICML (InCopy Markup Language) generator for back-of-shirt names.

Generates an .icml file that Adobe InDesign CS6 can open/place with fully
editable, pre-styled text.  The ICML mirrors the PDF as closely as possible:

- True small caps on titles and column headers (first letter large, rest small)
- Center-aligned tab stops at [72, 192, 306, 420, 546] pt for 5-column layout
- Letter-spaced level dividers in the accent color
- Named color swatch for the accent color
- Times New Roman font (or Helvetica when --font-family sans-serif)

Place the ICML into a full-width text frame (0-612 pt on Letter) so that
the tab-stop columns align with the PDF.

What the ICML CANNOT replicate (needs manual InDesign work):
- Red filled oval behind the group label (graphic, not text)
- Red horizontal lines flanking level dividers (graphic)
- Red underlines below column headers (graphic)
The InDesign user should add these decorations manually.

Paragraph styles emitted:
  PageTitle   - "{Year} GYMNASTICS" / "STATE CHAMPIONS OF {STATE}" (small caps)
  GroupLabel  - Oval label text (e.g. "XCEL", "LEVELS 10-7")
  ColumnHeaders - "VAULT  BARS  BEAM  FLOOR  ALL AROUND" (tabbed small caps)
  LevelDivider  - "L E V E L  1 0", "S A P P H I R E", etc.
  WinnerName    - Individual athlete names (tabbed 5 columns)
  Copyright     - Footer text
"""

from xml.etree.ElementTree import Element, SubElement, tostring, indent

from python.core.pdf_generator import (
    XCEL_MAP, XCEL_ORDER, EVENT_KEYS, COL_HEADERS, COL_CENTERS,
    TITLE1_LARGE, TITLE1_SMALL, TITLE2_LARGE, TITLE2_SMALL,
    HEADER_LARGE, HEADER_SMALL, LEVEL_DIVIDER_SIZE, OVAL_LABEL_SIZE,
    DEFAULT_NAME_SIZE, COPYRIGHT_SIZE,
    DEFAULT_SPORT, DEFAULT_TITLE_PREFIX, DEFAULT_COPYRIGHT,
    FONT_REGULAR, FONT_BOLD,
    precompute_shirt_data,
)

# Map PDF font names to InDesign font family names
_ID_FONT = {
    'Times-Roman': 'Times New Roman',
    'Times-Bold': 'Times New Roman',
    'Helvetica': 'Helvetica',
    'Helvetica-Bold': 'Helvetica',
}

ACCENT_COLOR_REF = 'Color/CHP Accent'


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def generate_shirt_icml(db_path: str, meet_name: str, output_path: str,
                        year: str = '2026', state: str = 'Maryland',
                        line_spacing: float = None, level_gap: float = None,
                        max_fill: float = None, min_font_size: float = None,
                        max_font_size: float = None,
                        name_sort: str = 'age',
                        max_shirt_pages: int = None,
                        title1_size: float = None,
                        title2_size: float = None,
                        level_groups: str = None,
                        exclude_levels: str = None,
                        copyright: str = None, sport: str = None,
                        title_prefix: str = None,
                        accent_color: str = None,
                        font_family: str = None,
                        header_size: float = None,
                        divider_size: float = None):
    """Generate back-of-shirt ICML file for InDesign.

    Uses the same data query, level grouping, and style params as the PDF
    generator so the two outputs always match.
    """
    pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                line_spacing=line_spacing, level_gap=level_gap,
                                max_fill=max_fill, max_font_size=max_font_size,
                                max_shirt_pages=max_shirt_pages,
                                title1_size=title1_size,
                                title2_size=title2_size,
                                level_groups=level_groups,
                                exclude_levels=exclude_levels,
                                copyright=copyright, sport=sport,
                                title_prefix=title_prefix,
                                accent_color=accent_color,
                                font_family=font_family,
                                header_size=header_size,
                                divider_size=divider_size)

    # Extract all resolved values from precompute
    style = {
        'page_groups': pre['page_groups'],
        'data': pre['data'],
        't1l': pre['t1l'], 't1s': pre['t1s'],
        't2l': pre['t2l'], 't2s': pre['t2s'],
        'hl': pre.get('header_large', HEADER_LARGE),
        'hs': pre.get('header_small', HEADER_SMALL),
        'ds': pre.get('divider_size', LEVEL_DIVIDER_SIZE),
        'sport': pre.get('sport', DEFAULT_SPORT),
        'prefix': pre.get('title_prefix', DEFAULT_TITLE_PREFIX),
        'copyright': pre.get('copyright', DEFAULT_COPYRIGHT),
        'accent': pre.get('accent_color', (1, 0, 0)),
        'font_bold': pre.get('font_bold', FONT_BOLD),
        'font_regular': pre.get('font_regular', FONT_REGULAR),
    }

    _write_icml(output_path, year, state, **style)


# ---------------------------------------------------------------------------
# ICML document builder
# ---------------------------------------------------------------------------

def _write_icml(output_path, year, state,
                page_groups=None, data=None,
                t1l=18, t1s=14, t2l=20, t2s=15,
                hl=11, hs=8, ds=10,
                sport=None, prefix=None, copyright=None,
                accent=(1, 0, 0),
                font_bold=FONT_BOLD, font_regular=FONT_REGULAR):
    """Build and write the ICML XML document."""
    s_sport = sport or DEFAULT_SPORT
    s_prefix = prefix or DEFAULT_TITLE_PREFIX
    s_copyright = copyright or DEFAULT_COPYRIGHT
    id_font = _ID_FONT.get(font_bold, 'Times New Roman')

    # -- Document root --
    doc = Element('Document')
    doc.set('DOMVersion', '8.0')
    doc.set('Self', 'd')

    # -- Color swatch --
    r, g, b = (int(c * 255) for c in accent)
    _add_color(doc, 'CHP Accent', f'{r} {g} {b}')

    # -- Character styles (just the required default) --
    char_root = SubElement(doc, 'RootCharacterStyleGroup')
    char_root.set('Self', 'u10')
    cs = SubElement(char_root, 'CharacterStyle')
    cs.set('Self', 'CharacterStyle/$ID/[No character style]')
    cs.set('Name', '$ID/[No character style]')

    # -- Paragraph styles --
    para_root = SubElement(doc, 'RootParagraphStyleGroup')
    para_root.set('Self', 'u11')
    _add_para_style(para_root, '$ID/[No paragraph style]')
    _add_para_style(para_root, 'PageTitle',
                    Justification='CenterAlign',
                    AppliedFont=id_font, FontStyle='Bold')
    _add_para_style(para_root, 'GroupLabel',
                    PointSize=str(OVAL_LABEL_SIZE),
                    Justification='CenterAlign',
                    AppliedFont=id_font, FontStyle='Bold',
                    FillColor=ACCENT_COLOR_REF)
    _add_para_style(para_root, 'ColumnHeaders',
                    Justification='LeftAlign',
                    AppliedFont=id_font, FontStyle='Bold',
                    tab_stops=COL_CENTERS)
    _add_para_style(para_root, 'LevelDivider',
                    PointSize=str(int(ds)),
                    Justification='CenterAlign',
                    AppliedFont=id_font, FontStyle='Bold',
                    FillColor=ACCENT_COLOR_REF)
    _add_para_style(para_root, 'WinnerName',
                    PointSize=str(int(DEFAULT_NAME_SIZE)),
                    Justification='LeftAlign',
                    AppliedFont=id_font, FontStyle='Regular',
                    tab_stops=COL_CENTERS)
    _add_para_style(para_root, 'Copyright',
                    PointSize=str(int(COPYRIGHT_SIZE)),
                    Justification='CenterAlign',
                    AppliedFont=id_font, FontStyle='Regular')

    # -- Story --
    story = SubElement(doc, 'Story')
    story.set('Self', 'u12')
    story.set('TrackChanges', 'false')
    story.set('StoryTitle', '')
    story.set('AppliedTOCStyle', 'n')
    story.set('AppliedNamedGrid', 'n')
    sp = SubElement(story, 'StoryPreference')
    sp.set('OpticalMarginAlignment', 'false')
    sp.set('OpticalMarginSize', '12')

    if not page_groups or data is None:
        _add_plain_para(story, 'PageTitle', '(No winners data)',
                        is_last=True, size=t1l, style='Bold', font=id_font)
        _write_xml(doc, output_path)
        return

    # Pre-count total paragraphs so we know which is last (for Br logic)
    total = _count_paragraphs(page_groups, data)
    n = 0  # running paragraph counter

    for page_idx, (label, group_levels) in enumerate(page_groups):
        start_page = 'NextPage' if page_idx > 0 else None

        # Title line 1: small caps
        n += 1
        _add_small_caps_para(story, 'PageTitle',
                             f'{year} {s_sport}', t1l, t1s,
                             is_last=(n == total), start_paragraph=start_page,
                             font=id_font)

        # Title line 2: small caps
        n += 1
        _add_small_caps_para(story, 'PageTitle',
                             f'{s_prefix} {state.upper()}', t2l, t2s,
                             is_last=(n == total), font=id_font)

        # Group label (red text — approximation of white-on-red-oval)
        n += 1
        _add_plain_para(story, 'GroupLabel', label,
                        is_last=(n == total),
                        size=OVAL_LABEL_SIZE, style='Bold', font=id_font,
                        color=ACCENT_COLOR_REF)

        # Column headers: tabbed small caps
        n += 1
        _add_tabbed_small_caps_para(story, 'ColumnHeaders',
                                    COL_HEADERS, hl, hs,
                                    is_last=(n == total), font=id_font)

        for level in group_levels:
            # Level divider: letter-spaced, red
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'

            n += 1
            _add_plain_para(story, 'LevelDivider', _space_text(divider_text),
                            is_last=(n == total),
                            size=ds, style='Bold', font=id_font,
                            color=ACCENT_COLOR_REF)

            # Name rows
            event_names = []
            max_names = 0
            for event in EVENT_KEYS:
                names = data[event].get(level, [])
                event_names.append(names)
                max_names = max(max_names, len(names))

            for row_idx in range(max_names):
                cells = []
                for col_names in event_names:
                    if row_idx < len(col_names):
                        cells.append(col_names[row_idx])
                    else:
                        cells.append('')
                n += 1
                _add_plain_para(story, 'WinnerName',
                                '\t' + '\t'.join(cells),
                                is_last=(n == total),
                                size=DEFAULT_NAME_SIZE, style='Regular',
                                font=id_font)

        # Copyright
        n += 1
        _add_plain_para(story, 'Copyright', s_copyright,
                        is_last=(n == total),
                        size=COPYRIGHT_SIZE, style='Regular', font=id_font)

    _write_xml(doc, output_path)


# ---------------------------------------------------------------------------
# Paragraph helpers
# ---------------------------------------------------------------------------

def _add_plain_para(story, style_name, text, is_last=False,
                    start_paragraph=None,
                    size=9, style='Regular', font='Times New Roman',
                    color=None):
    """Add a single-style paragraph."""
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', f'ParagraphStyle/{style_name}')
    if start_paragraph:
        psr.set('StartParagraph', start_paragraph)

    csr = _make_csr(psr, size, style, font, color)
    content = SubElement(csr, 'Content')
    content.text = text
    if not is_last:
        SubElement(csr, 'Br')


def _add_small_caps_para(story, style_name, text, large_size, small_size,
                         is_last=False, start_paragraph=None,
                         font='Times New Roman', color=None):
    """Add a paragraph with true small caps: first letter of each word large,
    remaining letters small. Matches the PDF's _draw_small_caps() rendering."""
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', f'ParagraphStyle/{style_name}')
    if start_paragraph:
        psr.set('StartParagraph', start_paragraph)

    last_csr = None
    words = text.upper().split()
    for wi, word in enumerate(words):
        # Space before word (except first) — at large size for proper spacing
        pfx = ' ' if wi > 0 else ''

        # First character at large size
        csr = _make_csr(psr, large_size, 'Bold', font, color)
        c = SubElement(csr, 'Content')
        c.text = pfx + word[0]
        last_csr = csr

        # Remaining characters at small size
        if len(word) > 1:
            csr = _make_csr(psr, small_size, 'Bold', font, color)
            c = SubElement(csr, 'Content')
            c.text = word[1:]
            last_csr = csr

    if not is_last and last_csr is not None:
        SubElement(last_csr, 'Br')


def _add_tabbed_small_caps_para(story, style_name, headers, large_size,
                                small_size, is_last=False,
                                font='Times New Roman', color=None):
    """Add tab-separated column headers in small caps.

    Each header entry is preceded by a tab character so it lands on the
    corresponding center-aligned tab stop.
    """
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', f'ParagraphStyle/{style_name}')

    last_csr = None
    for header in headers:
        sub_words = header.upper().split()
        for swi, word in enumerate(sub_words):
            # Tab before first sub-word of each column entry;
            # space before subsequent sub-words (e.g. "ALL AROUND")
            pfx = '\t' if swi == 0 else ' '

            # First character at large size
            csr = _make_csr(psr, large_size, 'Bold', font, color)
            c = SubElement(csr, 'Content')
            c.text = pfx + word[0]
            last_csr = csr

            # Remaining characters at small size
            if len(word) > 1:
                csr = _make_csr(psr, small_size, 'Bold', font, color)
                c = SubElement(csr, 'Content')
                c.text = word[1:]
                last_csr = csr

    if not is_last and last_csr is not None:
        SubElement(last_csr, 'Br')


# ---------------------------------------------------------------------------
# Low-level XML helpers
# ---------------------------------------------------------------------------

def _make_csr(parent, point_size, font_style, font_name, fill_color=None):
    """Create a CharacterStyleRange element with formatting attributes."""
    csr = SubElement(parent, 'CharacterStyleRange')
    csr.set('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]')
    csr.set('PointSize', str(int(point_size)) if point_size == int(point_size)
            else str(round(point_size, 1)))
    csr.set('FontStyle', font_style)
    csr.set('AppliedFont', font_name)
    if fill_color:
        csr.set('FillColor', fill_color)
    return csr


def _add_color(doc, name, color_value):
    """Add an RGB color swatch to the ICML document."""
    color = SubElement(doc, 'Color')
    color.set('Self', f'Color/{name}')
    color.set('Name', name)
    color.set('Model', 'Process')
    color.set('Space', 'RGB')
    color.set('ColorValue', color_value)


def _add_para_style(parent, name, tab_stops=None, **attrs):
    """Add a ParagraphStyle element with optional tab stops."""
    ps = SubElement(parent, 'ParagraphStyle')
    ps.set('Self', f'ParagraphStyle/{name}')
    ps.set('Name', name)
    for k, v in attrs.items():
        ps.set(k, v)

    if tab_stops:
        props = SubElement(ps, 'Properties')
        tab_list = SubElement(props, 'TabList')
        tab_list.set('type', 'list')
        for pos in tab_stops:
            item = SubElement(tab_list, 'ListItem')
            item.set('type', 'record')
            alignment = SubElement(item, 'Alignment')
            alignment.set('type', 'enumeration')
            alignment.text = 'CenterAlign'
            align_char = SubElement(item, 'AlignmentCharacter')
            align_char.set('type', 'string')
            align_char.text = '.'
            leader = SubElement(item, 'Leader')
            leader.set('type', 'string')
            leader.text = ''
            position = SubElement(item, 'Position')
            position.set('type', 'unit')
            position.text = str(pos)


def _space_text(text):
    """Add letter spacing: 'LEVEL 10' -> 'L E V E L  1 0'.

    Same algorithm as pdf_generator._space_text().
    """
    words = text.split()
    spaced_words = [' '.join(list(word)) for word in words]
    return '  '.join(spaced_words)


def _count_paragraphs(page_groups, data):
    """Count total paragraphs across all page groups."""
    total = 0
    for _, group_levels in page_groups:
        total += 4  # title1 + title2 + group label + headers
        for level in group_levels:
            total += 1  # divider
            max_names = max(len(data[event].get(level, []))
                           for event in EVENT_KEYS)
            total += max_names
        total += 1  # copyright
    return total


def _write_xml(doc, output_path):
    """Write the ICML XML to file with proper headers."""
    indent(doc, space='  ')
    rough = tostring(doc, encoding='unicode')

    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<?aid style="50" type="snippet" readerVersion="6.0" '
        'featureSet="513" product="8.0(370)" ?>',
        '<?aid SnippetType="InCopyInterchange" ?>',
    ]

    for line in rough.split('\n'):
        if line.strip().startswith('<?xml'):
            continue
        if line.strip():
            lines.append(line)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
