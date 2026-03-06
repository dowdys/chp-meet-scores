"""ICML (InCopy Markup Language) generator for back-of-shirt names.

Generates an .icml file that Adobe InDesign can open/place with fully
editable, pre-styled text. The ICML mirrors the same data as the PDF:
event winners organized by level group, with paragraph styles applied
so the InDesign user can restyle globally.

Paragraph styles emitted:
  - PageTitle: "2026 GYMNASTICS" / "STATE CHAMPIONS OF MICHIGAN"
  - GroupLabel: The oval label (e.g., "XCEL", "LEVELS 10-7")
  - ColumnHeaders: "VAULT  BARS  BEAM  FLOOR  ALL AROUND"
  - LevelDivider: "LEVEL 10", "SAPPHIRE", etc.
  - WinnerName: Individual athlete names
  - Copyright: Footer text
  - PageBreak: Empty paragraph that forces a new page (BreakType="NextPageBreak")
"""

import sqlite3
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom import minidom

# Reuse constants from pdf_generator
from python.core.pdf_generator import (
    XCEL_MAP, XCEL_ORDER, EVENT_KEYS, COL_HEADERS,
    LINE_HEIGHT_RATIO, LEVEL_GAP, DEFAULT_NAME_SIZE, MAX_PAGE_FILL,
    MIN_NAME_SIZE, NAMES_BOTTOM_Y, NAMES_START_Y,
    _get_winners_by_event_and_level, _bin_pack_levels,
)


def generate_shirt_icml(db_path: str, meet_name: str, output_path: str,
                        year: str = '2026', state: str = 'Maryland',
                        line_spacing: float = None, level_gap: float = None,
                        max_fill: float = None, min_font_size: float = None,
                        max_font_size: float = None,
                        name_sort: str = 'age'):
    """Generate back-of-shirt ICML file for InDesign.

    Uses the same data query and level grouping as the PDF generator
    so the two outputs always match.
    """
    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    levels, data = _get_winners_by_event_and_level(db_path, meet_name,
                                                    name_sort=name_sort)
    if not levels:
        # Write minimal empty ICML
        _write_icml([], output_path, year, state)
        return

    # Classify and sort levels (same logic as pdf_generator)
    xcel_levels = []
    numbered_levels = []
    for level in levels:
        if level in XCEL_MAP:
            xcel_levels.append(level)
        else:
            numbered_levels.append(level)

    xcel_levels.sort(key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                     if XCEL_MAP.get(lv) in XCEL_ORDER else 99)
    numbered_levels.sort(key=lambda lv: -int(lv) if lv.isdigit() else 0)

    # Build page groups (same bin-packing as PDF)
    available = (NAMES_BOTTOM_Y - NAMES_START_Y) * mfill
    page_groups = []

    if xcel_levels:
        xcel_groups = _bin_pack_levels(xcel_levels, data, available, lhr, lgap, mxfs)
        for group in xcel_groups:
            page_groups.append(('XCEL', group))

    if numbered_levels:
        groups = _bin_pack_levels(numbered_levels, data, available, lhr, lgap, mxfs)
        for group in groups:
            nums = sorted([int(lv) for lv in group if lv.isdigit()])
            if len(nums) >= 2:
                label = f'LEVELS {nums[-1]}-{nums[0]}'
            elif len(nums) == 1:
                label = f'LEVEL {nums[0]}'
            else:
                label = 'LEVELS'
            page_groups.append((label, group))

    _write_icml(page_groups, output_path, year, state, data)


def _write_icml(page_groups, output_path, year, state, data=None):
    """Build and write the ICML XML document."""
    # Root document
    doc = Element('Document')
    doc.set('DOMVersion', '8.0')
    doc.set('Self', 'chp_doc')

    # Character styles
    char_root = SubElement(doc, 'RootCharacterStyleGroup')
    char_root.set('Self', 'chp_char_styles')
    _add_char_style(char_root, '[No character style]')
    _add_char_style(char_root, 'Bold', FontStyle='Bold')
    _add_char_style(char_root, 'BoldRed', FontStyle='Bold', FillColor='Color/Red')

    # Paragraph styles
    para_root = SubElement(doc, 'RootParagraphStyleGroup')
    para_root.set('Self', 'chp_para_styles')
    _add_para_style(para_root, 'PageTitle', PointSize='18', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'GroupLabel', PointSize='14', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'ColumnHeaders', PointSize='9', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'LevelDivider', PointSize='10', FontStyle='Bold',
                    Justification='CenterAlign', FillColor='Color/Red')
    _add_para_style(para_root, 'WinnerName', PointSize='9', FontStyle='Regular',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'Copyright', PointSize='7', FontStyle='Regular',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'PageBreak', PointSize='2')

    # Story (the text flow)
    story = SubElement(doc, 'Story')
    story.set('Self', 'chp_story')
    story.set('TrackChanges', 'false')
    story.set('StoryTitle', '')
    story.set('AppliedTOCStyle', 'n')
    sp = SubElement(story, 'StoryPreference')
    sp.set('OpticalMarginAlignment', 'false')

    if not page_groups or data is None:
        _add_paragraph(story, 'PageTitle', '(No winners data)')
        _write_xml(doc, output_path)
        return

    for page_idx, (label, group_levels) in enumerate(page_groups):
        # Page break between pages (not before the first)
        if page_idx > 0:
            _add_page_break(story)

        # Title lines
        _add_paragraph(story, 'PageTitle', f'{year} GYMNASTICS')
        _add_paragraph(story, 'PageTitle', f'STATE CHAMPIONS OF {state.upper()}')

        # Group label (like the oval in the PDF)
        _add_paragraph(story, 'GroupLabel', label)

        # Column headers
        _add_paragraph(story, 'ColumnHeaders',
                       '     '.join(COL_HEADERS))

        # Each level in this group
        for level in group_levels:
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            _add_paragraph(story, 'LevelDivider', divider_text)

            # Names: one line per row, tab-separated across events
            # Find max names across all events for this level
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
                _add_paragraph(story, 'WinnerName', '\t'.join(cells))

        # Copyright
        _add_paragraph(story, 'Copyright', '\u00a9 C. H. Publishing')

    _write_xml(doc, output_path)


def _add_char_style(parent, name, **attrs):
    """Add a CharacterStyle element."""
    cs = SubElement(parent, 'CharacterStyle')
    if name == '[No character style]':
        cs.set('Self', 'CharacterStyle/$ID/[No character style]')
    else:
        cs.set('Self', f'CharacterStyle/{name}')
    cs.set('Name', name)
    for k, v in attrs.items():
        cs.set(k, v)


def _add_para_style(parent, name, **attrs):
    """Add a ParagraphStyle element."""
    ps = SubElement(parent, 'ParagraphStyle')
    ps.set('Self', f'ParagraphStyle/{name}')
    ps.set('Name', name)
    for k, v in attrs.items():
        ps.set(k, v)


def _add_paragraph(story, style_name, text):
    """Add a styled paragraph to the story."""
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', f'ParagraphStyle/{style_name}')
    csr = SubElement(psr, 'CharacterStyleRange')
    csr.set('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]')
    content = SubElement(csr, 'Content')
    content.text = text
    # Line break after paragraph
    SubElement(story, 'Br')


def _add_page_break(story):
    """Add a paragraph that forces a page break in InDesign."""
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', 'ParagraphStyle/PageBreak')
    props = SubElement(psr, 'Properties')
    pbreak = SubElement(props, 'ParagraphBreakType')
    pbreak.text = 'NextPageBreak'
    csr = SubElement(psr, 'CharacterStyleRange')
    csr.set('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]')
    content = SubElement(csr, 'Content')
    content.text = ''
    SubElement(story, 'Br')


def _write_xml(doc, output_path):
    """Write the ICML XML to file with proper headers."""
    rough = tostring(doc, encoding='unicode')
    parsed = minidom.parseString(rough)
    pretty = parsed.toprettyxml(indent='  ', encoding=None)

    # ICML requires specific processing instructions at the top
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<?aid style="50" type="snippet" readerVersion="6.0" featureSet="513" product="8.0(370)"?>',
    ]

    # Skip the XML declaration minidom adds and append the rest
    for line in pretty.split('\n'):
        if line.strip().startswith('<?xml'):
            continue
        if line.strip():
            lines.append(line)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
