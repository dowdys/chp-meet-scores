"""ICML (InCopy Markup Language) generator for back-of-shirt names.

Generates an .icml file that Adobe InDesign CS6 can open/place with fully
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
"""

import sqlite3
from xml.etree.ElementTree import Element, SubElement, tostring, indent

# Reuse constants from pdf_generator
from python.core.pdf_generator import (
    XCEL_MAP, XCEL_ORDER, EVENT_KEYS, COL_HEADERS,
    LINE_HEIGHT_RATIO, LEVEL_GAP, DEFAULT_NAME_SIZE, MAX_PAGE_FILL,
    MIN_NAME_SIZE, NAMES_BOTTOM_Y, NAMES_START_Y,
    _get_winners_by_event_and_level, _bin_pack_levels,
    precompute_shirt_data,
)


def generate_shirt_icml(db_path: str, meet_name: str, output_path: str,
                        year: str = '2026', state: str = 'Maryland',
                        line_spacing: float = None, level_gap: float = None,
                        max_fill: float = None, min_font_size: float = None,
                        max_font_size: float = None,
                        name_sort: str = 'age',
                        max_shirt_pages: int = None,
                        title1_size: float = None,
                        title2_size: float = None,
                        level_groups: str = None):
    """Generate back-of-shirt ICML file for InDesign.

    Uses the same data query and level grouping as the PDF generator
    so the two outputs always match.
    """
    pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                line_spacing=line_spacing, level_gap=level_gap,
                                max_fill=max_fill, max_font_size=max_font_size,
                                max_shirt_pages=max_shirt_pages,
                                title1_size=title1_size,
                                title2_size=title2_size,
                                level_groups=level_groups)
    page_groups = pre['page_groups']
    data = pre['data']

    if not page_groups:
        _write_icml([], output_path, year, state)
        return

    _write_icml(page_groups, output_path, year, state, data)


def _write_icml(page_groups, output_path, year, state, data=None):
    """Build and write the ICML XML document."""
    # Root document
    doc = Element('Document')
    doc.set('DOMVersion', '8.0')
    doc.set('Self', 'd')

    # Character styles — only the required default
    char_root = SubElement(doc, 'RootCharacterStyleGroup')
    char_root.set('Self', 'u10')
    cs = SubElement(char_root, 'CharacterStyle')
    cs.set('Self', 'CharacterStyle/$ID/[No character style]')
    cs.set('Name', '$ID/[No character style]')

    # Paragraph styles — default + our custom styles
    para_root = SubElement(doc, 'RootParagraphStyleGroup')
    para_root.set('Self', 'u11')
    _add_para_style(para_root, '$ID/[No paragraph style]')
    _add_para_style(para_root, 'PageTitle', PointSize='18', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'GroupLabel', PointSize='14', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'ColumnHeaders', PointSize='9', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'LevelDivider', PointSize='10', FontStyle='Bold',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'WinnerName', PointSize='9', FontStyle='Regular',
                    Justification='CenterAlign')
    _add_para_style(para_root, 'Copyright', PointSize='7', FontStyle='Regular',
                    Justification='CenterAlign')

    # Story (the text flow)
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
        _add_paragraph(story, 'PageTitle', '(No winners data)', is_last=True)
        _write_xml(doc, output_path)
        return

    # Build all paragraphs. Collect them first so we know which is last.
    # Each entry: (style_name, text, start_paragraph)
    paras = []
    for page_idx, (label, group_levels) in enumerate(page_groups):
        # First title on pages after the first gets StartParagraph="NextPage"
        start_para = 'NextPage' if page_idx > 0 else None

        paras.append(('PageTitle', f'{year} GYMNASTICS', start_para))
        paras.append(('PageTitle', f'STATE CHAMPIONS OF {state.upper()}', None))
        paras.append(('GroupLabel', label, None))
        paras.append(('ColumnHeaders', '     '.join(COL_HEADERS), None))

        for level in group_levels:
            if level in XCEL_MAP:
                divider_text = XCEL_MAP[level]
            else:
                divider_text = f'LEVEL {level}'
            paras.append(('LevelDivider', divider_text, None))

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
                paras.append(('WinnerName', '\t'.join(cells), None))

        paras.append(('Copyright', '\u00a9 C. H. Publishing', None))

    # Emit paragraphs — every one gets <Br/> except the last
    for i, (style_name, text, start_para) in enumerate(paras):
        is_last = (i == len(paras) - 1)
        _add_paragraph(story, style_name, text, is_last=is_last,
                       start_paragraph=start_para)

    _write_xml(doc, output_path)


def _add_para_style(parent, name, **attrs):
    """Add a ParagraphStyle element."""
    ps = SubElement(parent, 'ParagraphStyle')
    # System default styles use $ID/ prefix in both Self and Name
    if name.startswith('$ID/'):
        ps.set('Self', f'ParagraphStyle/{name}')
        ps.set('Name', name)
    else:
        ps.set('Self', f'ParagraphStyle/{name}')
        ps.set('Name', name)
    for k, v in attrs.items():
        ps.set(k, v)


def _add_paragraph(story, style_name, text, is_last=False,
                   start_paragraph=None):
    """Add a styled paragraph to the story.

    Per the IDML spec (p.215-218), <Br/> is a child of
    <CharacterStyleRange>, placed after <Content> as a sibling.
    Every paragraph gets a <Br/> after its content EXCEPT the last
    paragraph in the story.

    Page breaks use StartParagraph="NextPage" on the PSR (p.217).
    """
    psr = SubElement(story, 'ParagraphStyleRange')
    psr.set('AppliedParagraphStyle', f'ParagraphStyle/{style_name}')
    if start_paragraph:
        psr.set('StartParagraph', start_paragraph)
    csr = SubElement(psr, 'CharacterStyleRange')
    csr.set('AppliedCharacterStyle', 'CharacterStyle/$ID/[No character style]')
    content = SubElement(csr, 'Content')
    content.text = text
    if not is_last:
        SubElement(csr, 'Br')


def _write_xml(doc, output_path):
    """Write the ICML XML to file with proper headers."""
    # Use ElementTree's indent (avoids minidom quirks)
    indent(doc, space='  ')
    rough = tostring(doc, encoding='unicode')

    # ICML requires specific processing instructions at the top
    lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<?aid style="50" type="snippet" readerVersion="6.0" featureSet="513" product="8.0(370)" ?>',
        '<?aid SnippetType="InCopyInterchange" ?>',
    ]

    # Append the document XML (skip any XML declaration ET might add)
    for line in rough.split('\n'):
        if line.strip().startswith('<?xml'):
            continue
        if line.strip():
            lines.append(line)

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
