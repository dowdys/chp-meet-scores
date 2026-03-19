"""IDML (InDesign Markup Language) generator for back-of-shirt names.

Generates a .idml file (ZIP of XML files) that Adobe InDesign CS6+ can open
as a fully editable document with:

- Small-caps title and state line
- Red filled oval behind the group label text
- Small-caps column headers with red underlines (GraphicLine elements)
- Red horizontal lines flanking letter-spaced level dividers
- Tabbed 5-column name layout
- Copyright footer

This is a complete InDesign document — unlike ICML, it includes vector
graphics (ovals, lines) and does not require manual decoration work.

DOMVersion 8.0 targets InDesign CS6 and is compatible with all later versions.
"""

import json
import math
import zipfile

import fitz  # PyMuPDF — used for precise font metric measurements
from xml.sax.saxutils import escape as xml_escape

from python.core.constants import (
    PAGE_W, PAGE_H,
    XCEL_MAP, XCEL_PRESTIGE_ORDER as XCEL_ORDER,
    EVENTS as EVENT_KEYS, EVENT_HEADERS, COL_CENTERS,
    TITLE1_LARGE, TITLE1_SMALL, TITLE2_LARGE, TITLE2_SMALL,
    HEADER_LARGE, HEADER_SMALL, LEVEL_DIVIDER_SIZE, OVAL_LABEL_SIZE,
    DEFAULT_NAME_SIZE, COPYRIGHT_SIZE, COPYRIGHT_Y,
    DEFAULT_SPORT, DEFAULT_TITLE_PREFIX, DEFAULT_COPYRIGHT,
    FONT_REGULAR, FONT_BOLD,
    RED, BLACK, WHITE,
)
from python.core.layout_engine import (
    compute_layout, fit_font_size, space_text,
    precompute_shirt_data,
)
from python.core.rendering_utils import measure_small_caps_width

# Map PDF font names to InDesign font family / style / PostScript names
_FONT_MAP = {
    'Times-Roman': ('Times New Roman', 'Regular', 'TimesNewRomanPSMT'),
    'Times-Bold': ('Times New Roman', 'Bold', 'TimesNewRomanPS-BoldMT'),
    'Helvetica': ('Helvetica', 'Regular', 'Helvetica'),
    'Helvetica-Bold': ('Helvetica', 'Bold', 'Helvetica-Bold'),
}

# Namespace used in all IDML package files
_NS = 'http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging'

class _UidCounter:
    """Per-generation unique ID counter.

    Created fresh at the start of each generate_shirt_idml() call to avoid
    stale state from previous runs.
    """
    __slots__ = ('_count',)

    def __init__(self):
        self._count = 0

    def __call__(self):
        """Generate a unique ID string for Self attributes."""
        self._count += 1
        return f'u{self._count:04x}'


# Module-level instance replaced at the start of each generation call.
_uid = _UidCounter()


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def generate_shirt_idml(db_path: str, meet_name: str, output_path: str,
                        year: str = '2026', state: str = 'Maryland',
                        layout=None,
                        name_sort: str = 'age',
                        level_groups: str = None,
                        exclude_levels: str = None,
                        page_h: int = None,
                        page_group_filter: list = None,
                        precomputed: dict = None):
    """Generate back-of-shirt IDML file for InDesign.

    Uses the same data query, level grouping, and style params as the PDF
    generator so the two outputs always match.
    """
    global _uid
    _uid = _UidCounter()

    _page_h = page_h or PAGE_H
    if precomputed is not None:
        pre = precomputed
    else:
        pre = precompute_shirt_data(db_path, meet_name, name_sort=name_sort,
                                    layout=layout,
                                    level_groups=level_groups,
                                    exclude_levels=exclude_levels,
                                    page_h=_page_h)

    style = {
        'page_groups': pre['page_groups'],
        'data': pre['data'],
        't1l': pre['t1l'], 't1s': pre['t1s'],
        't2l': pre['t2l'], 't2s': pre['t2s'],
        'lhr': pre['lhr'], 'lgap': pre['lgap'],
        'mfill': pre['mfill'], 'mfs': pre['mfs'], 'mxfs': pre['mxfs'],
        'names_start_y': pre['names_start_y'],
        'title1_y': pre['title1_y'], 'title2_y': pre['title2_y'],
        'oval_y': pre['oval_y'], 'headers_y': pre['headers_y'],
        'hl': pre.get('header_large', HEADER_LARGE),
        'hs': pre.get('header_small', HEADER_SMALL),
        'ds': pre.get('divider_size', LEVEL_DIVIDER_SIZE),
        'sport': pre.get('sport', DEFAULT_SPORT),
        'prefix': pre.get('title_prefix', DEFAULT_TITLE_PREFIX),
        'copyright': pre.get('copyright', DEFAULT_COPYRIGHT),
        'accent': pre.get('accent_color', RED),
        'font_bold': pre.get('font_bold', FONT_BOLD),
        'font_regular': pre.get('font_regular', FONT_REGULAR),
    }

    _write_idml(output_path, year, state,
                meet_name=meet_name, db_path=db_path, page_h=_page_h,
                page_group_filter=page_group_filter, **style)


# ---------------------------------------------------------------------------
# IDML package builder
# ---------------------------------------------------------------------------

def _write_idml(output_path, year, state,
                meet_name='', db_path='',
                page_groups=None, data=None,
                t1l=TITLE1_LARGE, t1s=TITLE1_SMALL,
                t2l=TITLE2_LARGE, t2s=TITLE2_SMALL,
                lhr=1.15, lgap=6, mfill=0.90, mfs=6.5, mxfs=9,
                names_start_y=None, title1_y=None, title2_y=None,
                oval_y=None, headers_y=None,
                hl=HEADER_LARGE, hs=HEADER_SMALL,
                ds=LEVEL_DIVIDER_SIZE,
                sport=None, prefix=None, copyright=None,
                accent=RED,
                font_bold=FONT_BOLD, font_regular=FONT_REGULAR,
                page_h=None, page_group_filter=None):
    """Build and write the IDML ZIP package."""
    from functools import partial
    _ph = page_h or PAGE_H
    # Bind page_h into helper functions so callers don't repeat it
    _tf = partial(_text_frame, page_h=_ph)
    _ov = partial(_oval, page_h=_ph)
    _gl = partial(_graphic_line, page_h=_ph)

    s_sport = sport or DEFAULT_SPORT
    s_prefix = prefix or DEFAULT_TITLE_PREFIX
    s_copyright = copyright or DEFAULT_COPYRIGHT

    # Resolve font info
    fb_family, fb_style, fb_ps = _FONT_MAP.get(font_bold, ('Times New Roman', 'Bold', 'TimesNewRomanPS-BoldMT'))
    fr_family, fr_style, fr_ps = _FONT_MAP.get(font_regular, ('Times New Roman', 'Regular', 'TimesNewRomanPSMT'))

    # Resolve layout Y positions
    if title1_y is None:
        title1_y, title2_y, oval_y, headers_y, names_start_y = compute_layout(t1l, t2l)

    # Accent color as RGB 0-255
    ar, ag, ab = (int(c * 255) for c in accent)
    accent_name = 'CHP Accent'
    accent_ref = f'Color/{accent_name}'

    # --- Build per-page content ---
    # Each page gets: spread items (TextFrames, Ovals, GraphicLines) and stories
    layer_id = 'layer1'
    stories = []  # list of (story_id, story_xml_content)
    spreads = []  # list of spread XML strings (one spread per page)

    if not page_groups or data is None:
        # Empty placeholder page
        story_id = _uid()
        story_xml = _build_story(story_id, [
            _para_plain('PageTitle', '(No winners data)', t1l, fb_style, fb_family)
        ])
        stories.append((story_id, story_xml))
        frame_id = _uid()
        spread_xml = _build_spread(
            _uid(), _uid(), layer_id,
            [_tf(frame_id, story_id, layer_id, 0, 0, PAGE_W, _ph)],
            page_h=_ph
        )
        spreads.append(spread_xml)
    else:
        for label, group_levels in page_groups:
            # Filter page groups when generating legal-size subset
            if page_group_filter is not None:
                if not any(f.upper() in label.upper() for f in page_group_filter):
                    continue
            page_stories = []
            page_items = []

            # --- Title line 1 (small caps, centered) ---
            title1_text = f'{year} {s_sport}'
            s_id = _uid()
            s_xml = _build_story(s_id, [
                _para_small_caps('PageTitle', title1_text, t1l, t1s,
                                 fb_style, fb_family)
            ])
            stories.append((s_id, s_xml))
            # Text frame for title 1: full width, positioned at title1_y
            # Frame top = title1_y - font ascent (~0.8 * size)
            frame_top = title1_y - t1l * 0.85
            frame_h = t1l * 1.4
            tf_id = _uid()
            page_items.append(_tf(
                tf_id, s_id, layer_id, 0, frame_top, PAGE_W, frame_h,
                v_just='CenterAlign'
            ))

            # --- Title line 2 (small caps, centered) ---
            title2_text = f'{s_prefix} {state.upper()}'
            s_id = _uid()
            s_xml = _build_story(s_id, [
                _para_small_caps('PageTitle', title2_text, t2l, t2s,
                                 fb_style, fb_family)
            ])
            stories.append((s_id, s_xml))
            frame_top = title2_y - t2l * 0.85
            frame_h = t2l * 1.4
            tf_id = _uid()
            page_items.append(_tf(
                tf_id, s_id, layer_id, 0, frame_top, PAGE_W, frame_h,
                v_just='CenterAlign'
            ))

            # --- Oval with group label ---
            # Oval dimensions match PDF: spans Bars-to-Floor columns + padding
            oval_w = max(200, (COL_CENTERS[3] + 60) - (COL_CENTERS[1] - 60))
            oval_h = 22
            oval_x = PAGE_W / 2 - oval_w / 2
            oval_top = oval_y - oval_h / 2
            oval_id = _uid()
            page_items.append(_ov(
                oval_id, layer_id,
                oval_x, oval_top, oval_w, oval_h,
                fill_color=accent_ref
            ))

            # Label text on top of oval (white text)
            s_id = _uid()
            s_xml = _build_story(s_id, [
                _para_plain('GroupLabel', label, OVAL_LABEL_SIZE, fb_style,
                            fb_family, fill_color='Color/Paper')
            ])
            stories.append((s_id, s_xml))
            tf_id = _uid()
            page_items.append(_tf(
                tf_id, s_id, layer_id,
                oval_x, oval_top, oval_w, oval_h,
                v_just='CenterAlign'
            ))

            # --- Column headers (one text frame per column) ---
            hdr_top = headers_y - hl * 0.85
            hdr_h = hl * 1.6
            underline_y = headers_y + 3
            col_frame_w = 100  # width of each column header text frame

            for i, header in enumerate(EVENT_HEADERS):
                cx = COL_CENTERS[i]
                # Header text frame centered on column
                s_id = _uid()
                s_xml = _build_story(s_id, [
                    _para_small_caps('ColumnHeaders', header,
                                     hl, hs, fb_style, fb_family)
                ])
                stories.append((s_id, s_xml))
                tf_id = _uid()
                page_items.append(_tf(
                    tf_id, s_id, layer_id,
                    cx - col_frame_w / 2, hdr_top, col_frame_w, hdr_h,
                    v_just='CenterAlign'
                ))

                # Header underline — use small-caps width for accurate measurement
                approx_w = measure_small_caps_width(header, hl, hs, font=font_bold)
                line_id = _uid()
                page_items.append(_gl(
                    line_id, layer_id,
                    cx - approx_w / 2, underline_y,
                    cx + approx_w / 2, underline_y,
                    stroke_color=accent_ref, stroke_weight=0.5
                ))

            # --- Level sections with names ---
            font_size = fit_font_size(group_levels, data, lhr, lgap, mfill,
                                        mfs, mxfs,
                                        names_start_y=names_start_y,
                                        divider_size=ds,
                                        page_h=_ph)
            line_height = font_size * lhr
            y = names_start_y

            # Pass 1: render dividers/lines and collect per-column paragraphs
            # Each column accumulates all names across levels with spacing.
            col_paras = [[] for _ in EVENT_KEYS]  # paragraphs per column
            names_frame_top = None  # Y where names start (first level)
            is_first_level = True

            for level in group_levels:
                y += lgap

                # Level divider: letter-spaced text with flanking lines
                if level in XCEL_MAP:
                    divider_text = XCEL_MAP[level]
                else:
                    divider_text = f'LEVEL {level}'
                spaced = space_text(divider_text)

                # Divider text
                s_id = _uid()
                s_xml = _build_story(s_id, [
                    _para_plain('LevelDivider', spaced, ds, fb_style,
                                fb_family, fill_color=accent_ref)
                ])
                stories.append((s_id, s_xml))
                div_top = y - ds * 0.85
                div_h = ds * 1.4
                tf_id = _uid()
                page_items.append(_tf(
                    tf_id, s_id, layer_id, 0, div_top, PAGE_W, div_h,
                    v_just='CenterAlign'
                ))

                # Flanking lines — use actual font metrics instead of approximation
                line_y_pos = y - ds * 0.35
                approx_tw = fitz.get_text_length(spaced, fontname=font_bold, fontsize=ds)
                gap = 8
                left_margin = 40
                right_margin = PAGE_W - 40
                text_left = PAGE_W / 2 - approx_tw / 2
                text_right = PAGE_W / 2 + approx_tw / 2

                line_id = _uid()
                page_items.append(_gl(
                    line_id, layer_id,
                    left_margin, line_y_pos,
                    text_left - gap, line_y_pos,
                    stroke_color=accent_ref, stroke_weight=0.75
                ))
                line_id = _uid()
                page_items.append(_gl(
                    line_id, layer_id,
                    text_right + gap, line_y_pos,
                    right_margin, line_y_pos,
                    stroke_color=accent_ref, stroke_weight=0.75
                ))

                y += ds * 1.3

                if names_frame_top is None:
                    names_frame_top = y

                # Collect names for each event column
                event_names = []
                max_names = 0
                for event in EVENT_KEYS:
                    names = data[event].get(level, [])
                    event_names.append(names)
                    max_names = max(max_names, len(names))

                if max_names > 0:
                    # Space before this level's names (gap for divider area)
                    # For the first level, no extra space (frame starts here).
                    # For subsequent levels, add spacing to bridge the divider gap.
                    level_space = 0 if is_first_level else (lgap + ds * 1.3 + 1)

                    for col_idx, col_names in enumerate(event_names):
                        # Add names to this column's paragraph list
                        for ni, name in enumerate(col_names):
                            sb = level_space if ni == 0 else 0
                            col_paras[col_idx].append(
                                _para_plain('WinnerName', name, font_size,
                                            fr_style, fr_family,
                                            space_before=sb if sb > 0 else None)
                            )

                        # Pad shorter columns with empty paragraphs so levels align
                        pad_count = max_names - len(col_names)
                        if pad_count > 0 and not col_names:
                            # Column has no names at this level — add one spacer
                            # with the right spacing to keep alignment
                            col_paras[col_idx].append(
                                _para_plain('WinnerName', ' ', font_size,
                                            fr_style, fr_family,
                                            space_before=level_space if level_space > 0 else None)
                            )
                            pad_count -= 1
                        for _ in range(pad_count):
                            col_paras[col_idx].append(
                                _para_plain('WinnerName', ' ', font_size,
                                            fr_style, fr_family)
                            )

                y += max_names * line_height + 1
                is_first_level = False

            # Pass 2: create one text frame per column spanning all levels
            names_frame_h = y - names_frame_top if names_frame_top else 0
            if names_frame_top and names_frame_h > 0:
                for col_idx, paras in enumerate(col_paras):
                    if not paras:
                        continue
                    cx = COL_CENTERS[col_idx]
                    s_id = _uid()
                    s_xml = _build_story(s_id, paras)
                    stories.append((s_id, s_xml))
                    tf_id = _uid()
                    page_items.append(_tf(
                        tf_id, s_id, layer_id,
                        cx - col_frame_w / 2, names_frame_top,
                        col_frame_w, names_frame_h
                    ))

            # --- Copyright ---
            s_id = _uid()
            s_xml = _build_story(s_id, [
                _para_plain('Copyright', s_copyright, COPYRIGHT_SIZE,
                            fr_style, fr_family)
            ])
            stories.append((s_id, s_xml))
            _copyright_y = (_ph or PAGE_H) - 8
            cr_top = _copyright_y - COPYRIGHT_SIZE
            cr_h = COPYRIGHT_SIZE * 2
            tf_id = _uid()
            page_items.append(_tf(
                tf_id, s_id, layer_id, 0, cr_top, PAGE_W, cr_h,
                v_just='CenterAlign'
            ))

            # Build spread for this page
            spread_id = _uid()
            page_id = _uid()
            spread_xml = _build_spread(spread_id, page_id, layer_id, page_items, page_h=_ph)
            spreads.append(spread_xml)

    # --- Metadata story (hidden on pasteboard, identifies the meet) ---
    meta = json.dumps({
        'meet_name': meet_name,
        'state': state,
        'year': year,
        'db_path': db_path,
        'page_h': _ph,
    }, separators=(',', ':'))
    meta_story_id = _uid()
    meta_story_xml = _build_story(meta_story_id, [
        _para_plain('WinnerName', f'CHP_METADATA:{meta}', 1,
                     fr_style, fr_family, fill_color='Color/Paper')
    ])
    stories.append((meta_story_id, meta_story_xml))
    # Add a 1x1 text frame off-page (pasteboard) on the first spread
    meta_frame_id = _uid()
    meta_frame = _tf(meta_frame_id, meta_story_id, layer_id,
                              -200, -200, 1, 1)
    if spreads:
        # Insert the metadata frame into the first spread XML
        insert_before = '</Spread>'
        spreads[0] = spreads[0].replace(
            insert_before, f'    {meta_frame}\n  {insert_before}', 1)

    # --- Assemble the IDML ZIP ---
    story_ids = ' '.join(sid for sid, _ in stories)

    # Build file contents
    mimetype = 'application/vnd.adobe.indesign-idml-package'
    container_xml = _build_container()
    designmap_xml = _build_designmap(story_ids, layer_id, spreads, stories,
                                     accent_name, ar, ag, ab,
                                     fb_family, fb_style, fb_ps,
                                     fr_family, fr_style, fr_ps)
    fonts_xml = _build_fonts(fb_family, fb_style, fb_ps,
                             fr_family, fr_style, fr_ps)
    graphic_xml = _build_graphic(accent_name, ar, ag, ab)
    styles_xml = _build_styles(fb_family, fb_style, fr_family, fr_style,
                               ds, accent_ref)
    preferences_xml = _build_preferences(page_h=_ph)
    backing_story_xml = _build_backing_story()
    tags_xml = _build_tags()
    mapping_xml = _build_mapping()

    # Write ZIP (mimetype MUST be first, uncompressed)
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('mimetype', mimetype, compress_type=zipfile.ZIP_STORED)
        zf.writestr('META-INF/container.xml', container_xml)
        zf.writestr('designmap.xml', designmap_xml)
        zf.writestr('Resources/Fonts.xml', fonts_xml)
        zf.writestr('Resources/Graphic.xml', graphic_xml)
        zf.writestr('Resources/Styles.xml', styles_xml)
        zf.writestr('Resources/Preferences.xml', preferences_xml)
        for i, spread_xml in enumerate(spreads):
            # Extract spread Self ID from the XML for filename
            # Spread Self is after 'Self="' in the Spread element
            start = spread_xml.index('Spread Self="') + len('Spread Self="')
            end = spread_xml.index('"', start)
            s_self = spread_xml[start:end]
            zf.writestr(f'Spreads/Spread_{s_self}.xml', spread_xml)
        for sid, sxml in stories:
            zf.writestr(f'Stories/Story_{sid}.xml', sxml)
        zf.writestr('XML/BackingStory.xml', backing_story_xml)
        zf.writestr('XML/Tags.xml', tags_xml)
        zf.writestr('XML/Mapping.xml', mapping_xml)


# ---------------------------------------------------------------------------
# Story (text content) builders
# ---------------------------------------------------------------------------

def _build_story(story_id, paragraphs):
    """Build a Story XML file wrapping paragraph content.

    Args:
        story_id: Unique story ID (e.g. "u0012")
        paragraphs: List of paragraph XML strings (ParagraphStyleRange elements)
    """
    # Join paragraphs with Br separators embedded in each paragraph
    # The last paragraph should NOT have a trailing Br
    para_xmls = []
    for i, p in enumerate(paragraphs):
        if i < len(paragraphs) - 1:
            # Append a Br to the last CharacterStyleRange in this paragraph
            p = _append_br(p)
        para_xmls.append(p)

    inner = '\n    '.join(para_xmls)
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Story xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <Story Self="{story_id}" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12"
      FrameType="TextFrameType" StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
    {inner}
  </Story>
</idPkg:Story>'''


def _append_br(para_xml):
    """Append a <Br/> inside the last CharacterStyleRange of a paragraph."""
    # Find the last </CharacterStyleRange> and insert <Br/> before it
    marker = '</CharacterStyleRange>'
    idx = para_xml.rfind(marker)
    if idx == -1:
        return para_xml
    return para_xml[:idx] + '<Br/>' + para_xml[idx:]


def _para_plain(style_name, text, point_size, font_style, font_family,
                fill_color=None, space_before=None):
    """Build a plain text ParagraphStyleRange XML string."""
    esc_text = xml_escape(text)
    fc_attr = f' FillColor="{fill_color}"' if fill_color else ''
    sb_attr = f' SpaceBefore="{_fmt_size(space_before)}"' if space_before else ''
    return f'''<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/{style_name}"{sb_attr}>
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"
        PointSize="{_fmt_size(point_size)}" FontStyle="{font_style}"{fc_attr}>
        <Properties>
          <AppliedFont type="string">{xml_escape(font_family)}</AppliedFont>
        </Properties>
        <Content>{esc_text}</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>'''


def _para_small_caps(style_name, text, large_size, small_size,
                     font_style, font_family, fill_color=None):
    """Build a small-caps ParagraphStyleRange: first letter large, rest small."""
    fc_attr = f' FillColor="{fill_color}"' if fill_color else ''
    csrs = []
    words = text.upper().split()
    for wi, word in enumerate(words):
        pfx = ' ' if wi > 0 else ''
        # First char at large size
        csrs.append(
            f'<CharacterStyleRange AppliedCharacterStyle='
            f'"CharacterStyle/$ID/[No character style]"'
            f' PointSize="{_fmt_size(large_size)}" FontStyle="{font_style}"{fc_attr}>'
            f'<Properties><AppliedFont type="string">{xml_escape(font_family)}'
            f'</AppliedFont></Properties>'
            f'<Content>{xml_escape(pfx + word[0])}</Content>'
            f'</CharacterStyleRange>'
        )
        # Rest at small size
        if len(word) > 1:
            csrs.append(
                f'<CharacterStyleRange AppliedCharacterStyle='
                f'"CharacterStyle/$ID/[No character style]"'
                f' PointSize="{_fmt_size(small_size)}" FontStyle="{font_style}"{fc_attr}>'
                f'<Properties><AppliedFont type="string">{xml_escape(font_family)}'
                f'</AppliedFont></Properties>'
                f'<Content>{xml_escape(word[1:])}</Content>'
                f'</CharacterStyleRange>'
            )
    inner = '\n      '.join(csrs)
    return f'''<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/{style_name}">
      {inner}
    </ParagraphStyleRange>'''



def _fmt_size(size):
    """Format a point size for XML attributes."""
    if size == int(size):
        return str(int(size))
    return str(round(size, 1))


# ---------------------------------------------------------------------------
# Spread / page item builders
# ---------------------------------------------------------------------------

def _build_spread(spread_id, page_id, layer_id, page_items, page_h=PAGE_H):
    """Build a Spread XML file for a single page.

    IDML coordinate system: Y increases downward. Spread origin is at center
    of spread. Page ItemTransform shifts up by half page height.
    """
    half_h = page_h / 2
    items_xml = '\n    '.join(page_items)
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Spread xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <Spread Self="{spread_id}" FlattenerOverride="Default"
    AllowPageShuffle="true" ItemTransform="1 0 0 1 0 0"
    ShowMasterItems="true" PageCount="1" BindingLocation="0">
    <Page Self="{page_id}" GeometricBounds="0 0 {page_h} {PAGE_W}"
      ItemTransform="1 0 0 1 0 -{half_h:.0f}" Name="1"
      AppliedTrapPreset="TrapPreset/$ID/kDefaultTrapStyleName"
      OverrideList="" AppliedMaster="n"
      MasterPageTransform="1 0 0 1 0 0" TabOrder=""
      GridStartingPoint="TopOutside" UseMasterGrid="true">
      <Properties>
        <PageColor type="enumeration">UseMasterColor</PageColor>
      </Properties>
      <MarginPreference ColumnCount="1" ColumnGutter="12"
        Top="36" Bottom="36" Left="36" Right="36"
        ColumnDirection="Horizontal" ColumnsPositions="0 540"/>
    </Page>
    {items_xml}
  </Spread>
</idPkg:Spread>'''


def _text_frame(frame_id, story_id, layer_id, x, y, w, h,
                v_just='TopAlign', page_h=PAGE_H):
    """Build a TextFrame XML element.

    Coordinates are in page space (origin at top-left of page).
    The ItemTransform shifts everything into spread coordinates.
    """
    half_h = page_h / 2
    x1, y1 = x, y
    x2, y2 = x + w, y + h
    return f'''<TextFrame Self="{frame_id}" ParentStory="{story_id}"
      PreviousTextFrame="n" NextTextFrame="n"
      ContentType="TextType" ItemLayer="{layer_id}"
      ItemTransform="1 0 0 1 0 -{half_h:.0f}">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType Anchor="{x1} {y1}" LeftDirection="{x1} {y1}" RightDirection="{x1} {y1}"/>
              <PathPointType Anchor="{x1} {y2}" LeftDirection="{x1} {y2}" RightDirection="{x1} {y2}"/>
              <PathPointType Anchor="{x2} {y2}" LeftDirection="{x2} {y2}" RightDirection="{x2} {y2}"/>
              <PathPointType Anchor="{x2} {y1}" LeftDirection="{x2} {y1}" RightDirection="{x2} {y1}"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
      <TextFramePreference TextColumnCount="1" TextColumnGutter="12"
        TextColumnFixedWidth="{w}"
        UseFixedColumnWidth="false"
        FirstBaselineOffset="AscentOffset"
        MinimumFirstBaselineOffset="0"
        VerticalJustification="{v_just}"
        VerticalThreshold="0" IgnoreWrap="false">
        <Properties>
          <InsetSpacing type="list">
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
            <ListItem type="unit">0</ListItem>
          </InsetSpacing>
        </Properties>
      </TextFramePreference>
    </TextFrame>'''


def _oval(oval_id, layer_id, x, y, w, h, fill_color='Color/Black', page_h=PAGE_H):
    """Build an Oval XML element using Bezier PathPointType.

    Uses the standard 4-point Bezier approximation for ellipses:
    control handle offset = radius * 0.5522847498
    """
    half_h_page = page_h / 2
    x1, y1 = x, y
    x2, y2 = x + w, y + h
    cx = (x1 + x2) / 2
    cy = (y1 + y2) / 2
    rx = w / 2
    ry = h / 2
    kx = rx * 0.5522847498
    ky = ry * 0.5522847498

    # Four cardinal points: top, right, bottom, left
    # Each has anchor + left/right control handles
    top = f'Anchor="{cx} {y1}" LeftDirection="{cx + kx} {y1}" RightDirection="{cx - kx} {y1}"'
    right = f'Anchor="{x2} {cy}" LeftDirection="{x2} {cy - ky}" RightDirection="{x2} {cy + ky}"'
    bottom = f'Anchor="{cx} {y2}" LeftDirection="{cx - kx} {y2}" RightDirection="{cx + kx} {y2}"'
    left = f'Anchor="{x1} {cy}" LeftDirection="{x1} {cy + ky}" RightDirection="{x1} {cy - ky}"'

    return f'''<Oval Self="{oval_id}" ItemLayer="{layer_id}"
      ItemTransform="1 0 0 1 0 -{half_h_page:.0f}"
      StrokeWeight="0" StrokeColor="Swatch/None" FillColor="{fill_color}">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="false">
            <PathPointArray>
              <PathPointType {top}/>
              <PathPointType {right}/>
              <PathPointType {bottom}/>
              <PathPointType {left}/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </Oval>'''


def _graphic_line(line_id, layer_id, x1, y1, x2, y2,
                  stroke_color='Color/Black', stroke_weight=1.0, page_h=PAGE_H):
    """Build a GraphicLine XML element."""
    half_h = page_h / 2
    return f'''<GraphicLine Self="{line_id}" ItemLayer="{layer_id}"
      ItemTransform="1 0 0 1 0 -{half_h:.0f}"
      StrokeWeight="{stroke_weight}" StrokeColor="{stroke_color}"
      FillColor="Swatch/None"
      LeftLineEnd="None" RightLineEnd="None"
      StrokeType="StrokeStyle/$ID/Solid">
      <Properties>
        <PathGeometry>
          <GeometryPathType PathOpen="true">
            <PathPointArray>
              <PathPointType Anchor="{x1} {y1}" LeftDirection="{x1} {y1}" RightDirection="{x1} {y1}"/>
              <PathPointType Anchor="{x2} {y2}" LeftDirection="{x2} {y2}" RightDirection="{x2} {y2}"/>
            </PathPointArray>
          </GeometryPathType>
        </PathGeometry>
      </Properties>
    </GraphicLine>'''


# ---------------------------------------------------------------------------
# Package structure files
# ---------------------------------------------------------------------------

def _build_container():
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="designmap.xml" media-type="text/xml"/>
  </rootfiles>
</container>'''


def _build_designmap(story_ids, layer_id, spreads, stories,
                     accent_name, ar, ag, ab,
                     fb_family, fb_style, fb_ps,
                     fr_family, fr_style, fr_ps):
    """Build the designmap.xml (document root manifest)."""
    # Spread references
    spread_refs = []
    for spread_xml in spreads:
        start = spread_xml.index('Spread Self="') + len('Spread Self="')
        end = spread_xml.index('"', start)
        s_self = spread_xml[start:end]
        spread_refs.append(
            f'  <idPkg:Spread src="Spreads/Spread_{s_self}.xml"/>')

    # Story references
    story_refs = []
    for sid, _ in stories:
        story_refs.append(f'  <idPkg:Story src="Stories/Story_{sid}.xml"/>')

    # Section references the first page
    first_spread = spreads[0]
    # Extract page Self ID
    pg_start = first_spread.index('Page Self="') + len('Page Self="')
    pg_end = first_spread.index('"', pg_start)
    first_page_id = first_spread[pg_start:pg_end]

    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<?aid style="50" type="document" readerVersion="6.0" featureSet="257" product="8.0(370)" ?>
<Document xmlns:idPkg="{_NS}"
  DOMVersion="8.0" Self="d" StoryList="{story_ids}"
  ZeroPoint="0 0" ActiveLayer="{layer_id}"
  CMYKProfile="U.S. Web Coated (SWOP) v2" RGBProfile="sRGB IEC61966-2.1"
  SolidColorIntent="UseColorSettings" AfterBlendingIntent="UseColorSettings"
  DefaultImageIntent="UseColorSettings" RGBPolicy="PreserveEmbeddedProfiles"
  CMYKPolicy="CombinationOfPreserveAndSafeCmyk" AccurateLABSpots="false">
  <idPkg:Graphic src="Resources/Graphic.xml"/>
  <idPkg:Fonts src="Resources/Fonts.xml"/>
  <idPkg:Styles src="Resources/Styles.xml"/>
  <idPkg:Preferences src="Resources/Preferences.xml"/>
  <Language Self="Language/$ID/English%3a USA" Name="$ID/English: USA"
    SingleQuotes="&#x2018;&#x2019;" DoubleQuotes="&#x201c;&#x201d;"
    PrimaryLanguageName="$ID/English" SublanguageName="$ID/USA"
    Id="269" HyphenationVendor="Hunspell" SpellingVendor="Hunspell"/>
  <idPkg:Tags src="XML/Tags.xml"/>
  <Layer Self="{layer_id}" Name="Layer 1" Visible="true" Locked="false"
    IgnoreWrap="false" ShowGuides="true" LockGuides="false"
    UI="true" Expendable="true" Printable="true">
    <Properties>
      <LayerColor type="enumeration">LightBlue</LayerColor>
    </Properties>
  </Layer>
{chr(10).join(spread_refs)}
  <Section Self="sec1" Length="{len(spreads)}" Name="" PageNumberStart="1"
    Marker="" PageStart="{first_page_id}" SectionPrefix=""
    IncludeSectionPrefix="false" ContinueNumbering="false">
    <Properties>
      <PageNumberStyle type="enumeration">Arabic</PageNumberStyle>
    </Properties>
  </Section>
  <idPkg:BackingStory src="XML/BackingStory.xml"/>
{chr(10).join(story_refs)}
</Document>'''


def _build_fonts(fb_family, fb_style, fb_ps, fr_family, fr_style, fr_ps):
    """Build Resources/Fonts.xml with the needed font families."""
    families = {}
    for family, style, ps in [(fb_family, fb_style, fb_ps),
                               (fr_family, fr_style, fr_ps)]:
        if family not in families:
            families[family] = {}
        families[family][style] = ps

    font_xml_parts = []
    for i, (family, styles) in enumerate(families.items()):
        fam_id = f'di{100 + i}'
        font_entries = []
        for style, ps in styles.items():
            font_type = 'TrueType'
            full_name = f'{family} {style}' if style != 'Regular' else family
            font_entries.append(
                f'    <Font Self="{fam_id}Font/{family} {style}" '
                f'FontFamily="{xml_escape(family)}" '
                f'Name="{xml_escape(family)} {style}" '
                f'PostScriptName="{xml_escape(ps)}" Status="Installed" '
                f'FontStyleName="{style}" FontType="{font_type}" '
                f'WritingScript="0" '
                f'FullName="{xml_escape(full_name)}" '
                f'FullNameNative="{xml_escape(full_name)}" '
                f'FontStyleNameNative="{style}" '
                f'PlatformName="$ID/" Version="Version 7.00"/>'
            )
        entries = '\n'.join(font_entries)
        font_xml_parts.append(
            f'  <FontFamily Self="{fam_id}" Name="{xml_escape(family)}">\n'
            f'{entries}\n'
            f'  </FontFamily>'
        )

    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Fonts xmlns:idPkg="{_NS}" DOMVersion="8.0">
{chr(10).join(font_xml_parts)}
</idPkg:Fonts>'''


def _build_graphic(accent_name, ar, ag, ab):
    """Build Resources/Graphic.xml with required colors + accent color."""
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Graphic xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <Swatch Self="Swatch/None" Name="None" ColorEditable="false"
    ColorRemovable="false" Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Black" Model="Process" Space="CMYK"
    ColorValue="0 0 0 100" ColorOverride="Specialblack" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Black" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Paper" Model="Process" Space="CMYK"
    ColorValue="0 0 0 0" ColorOverride="Specialpaper" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Paper" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/Registration" Model="Process" Space="CMYK"
    ColorValue="100 100 100 100" ColorOverride="Specialregistration" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="Registration" ColorEditable="false" ColorRemovable="false"
    Visible="true" SwatchCreatorID="7937"/>
  <Color Self="Color/{xml_escape(accent_name)}" Model="Process" Space="RGB"
    ColorValue="{ar} {ag} {ab}" BaseColor="n"
    AlternateSpace="NoAlternateColor" AlternateColorValue=""
    Name="{xml_escape(accent_name)}" ColorEditable="true" ColorRemovable="true"
    Visible="true" SwatchCreatorID="7937"/>
  <Ink Self="Ink/Cyan" Name="Cyan" IsProcessInk="true" AliasInkName=""
    Angle="75" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.61" PrintInk="true" TrapOrder="1" InkType="Normal"/>
  <Ink Self="Ink/Magenta" Name="Magenta" IsProcessInk="true" AliasInkName=""
    Angle="15" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.76" PrintInk="true" TrapOrder="2" InkType="Normal"/>
  <Ink Self="Ink/Yellow" Name="Yellow" IsProcessInk="true" AliasInkName=""
    Angle="0" ConvertToProcess="false" Frequency="70"
    NeutralDensity="0.16" PrintInk="true" TrapOrder="3" InkType="Normal"/>
  <Ink Self="Ink/Black" Name="Black" IsProcessInk="true" AliasInkName=""
    Angle="45" ConvertToProcess="false" Frequency="70"
    NeutralDensity="1.7" PrintInk="true" TrapOrder="4" InkType="Normal"/>
  <StrokeStyle Self="StrokeStyle/$ID/Solid" Name="$ID/Solid"/>
</idPkg:Graphic>'''


def _build_styles(fb_family, fb_style, fr_family, fr_style,
                  divider_size, accent_ref):
    """Build Resources/Styles.xml with paragraph/character/object styles."""
    # Tab stops for column headers and winner names


    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Styles xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <RootParagraphStyleGroup Self="rstyle_p">
    <ParagraphStyle Self="ParagraphStyle/$ID/[No paragraph style]"
      Name="$ID/[No paragraph style]" Imported="false"
      NextStyle="ParagraphStyle/$ID/[No paragraph style]"
      KeyboardShortcut="0 0"/>
    <ParagraphStyle Self="ParagraphStyle/$ID/NormalParagraphStyle"
      Name="$ID/NormalParagraphStyle" Imported="false"
      NextStyle="ParagraphStyle/$ID/NormalParagraphStyle"
      KeyboardShortcut="0 0" PointSize="12" FontStyle="{fr_style}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fr_family)}</AppliedFont>
        <Leading type="unit">14.4</Leading>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/PageTitle" Name="PageTitle"
      Justification="CenterAlign" FontStyle="{fb_style}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fb_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/GroupLabel" Name="GroupLabel"
      PointSize="{OVAL_LABEL_SIZE}" Justification="CenterAlign"
      FontStyle="{fb_style}" FillColor="Color/Paper">
      <Properties>
        <AppliedFont type="string">{xml_escape(fb_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/ColumnHeaders" Name="ColumnHeaders"
      Justification="CenterAlign" FontStyle="{fb_style}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fb_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/LevelDivider" Name="LevelDivider"
      PointSize="{_fmt_size(divider_size)}" Justification="CenterAlign"
      FontStyle="{fb_style}" FillColor="{accent_ref}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fb_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/WinnerName" Name="WinnerName"
      PointSize="{_fmt_size(DEFAULT_NAME_SIZE)}" Justification="CenterAlign"
      FontStyle="{fr_style}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fr_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
    <ParagraphStyle Self="ParagraphStyle/Copyright" Name="Copyright"
      PointSize="{_fmt_size(COPYRIGHT_SIZE)}" Justification="CenterAlign"
      FontStyle="{fr_style}">
      <Properties>
        <AppliedFont type="string">{xml_escape(fr_family)}</AppliedFont>
      </Properties>
    </ParagraphStyle>
  </RootParagraphStyleGroup>
  <RootCharacterStyleGroup Self="rstyle_c">
    <CharacterStyle Self="CharacterStyle/$ID/[No character style]"
      Name="$ID/[No character style]" Imported="false"/>
  </RootCharacterStyleGroup>
  <RootObjectStyleGroup Self="rstyle_o">
    <ObjectStyle Self="ObjectStyle/$ID/[None]" Name="$ID/[None]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Graphics Frame]"
      Name="$ID/[Normal Graphics Frame]"/>
    <ObjectStyle Self="ObjectStyle/$ID/[Normal Text Frame]"
      Name="$ID/[Normal Text Frame]"/>
  </RootObjectStyleGroup>
  <RootTableStyleGroup Self="rstyle_t">
    <TableStyle Self="TableStyle/$ID/[No table style]"
      Name="$ID/[No table style]"/>
  </RootTableStyleGroup>
  <RootCellStyleGroup Self="rstyle_cl">
    <CellStyle Self="CellStyle/$ID/[None]" Name="$ID/[None]"/>
  </RootCellStyleGroup>
</idPkg:Styles>'''



def _build_preferences(page_h=PAGE_H):
    """Build Resources/Preferences.xml."""
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Preferences xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <DocumentPreference Self="d-DocumentPreference1"
    PageHeight="{page_h}" PageWidth="{PAGE_W}" PagesPerDocument="1"
    FacingPages="false" DocumentBleedTopOffset="0"
    DocumentBleedBottomOffset="0" DocumentBleedInsideOrLeftOffset="0"
    DocumentBleedOutsideOrRightOffset="0" DocumentBleedUniformSize="true"
    SlugTopOffset="0" SlugBottomOffset="0" SlugInsideOrLeftOffset="0"
    SlugRightOrOutsideOffset="0" DocumentSlugUniformSize="false"
    PreserveLayoutWhenShuffling="true" AllowPageShuffle="true"
    OverprintBlack="true" PageBinding="LeftToRight"
    ColumnDirection="Horizontal" ColumnGuideLocked="true"
    MasterTextFrame="false" SnippetImportUsesOriginalLocation="false">
    <Properties>
      <ColumnGuideColor type="enumeration">Violet</ColumnGuideColor>
      <MarginGuideColor type="enumeration">Magenta</MarginGuideColor>
    </Properties>
  </DocumentPreference>
  <MarginPreference Self="d-MarginPreference1" ColumnCount="1"
    ColumnGutter="12" Top="36" Bottom="36" Left="36" Right="36"
    ColumnDirection="Horizontal" ColumnsPositions="0 540"/>
  <ViewPreference Self="d-ViewPreference1"
    HorizontalMeasurementUnits="Points" VerticalMeasurementUnits="Points"
    RulerOrigin="SpineOrigin" ShowRulers="true" ShowFrameEdges="true"
    CursorKeyIncrement="1" GuideSnaptoZone="4"/>
  <GridPreference Self="d-GridPreference1"
    DocumentGridShown="false" DocumentGridSnapto="false"
    HorizontalGridlineDivision="72" VerticalGridlineDivision="72"
    HorizontalGridSubdivision="8" VerticalGridSubdivision="8"
    GridsInBack="true" BaselineGridShown="false" BaselineStart="36"
    BaselineDivision="12" BaselineViewThreshold="75"
    BaselineGridRelativeOption="TopOfPageOfBaselineGridRelativeOption">
    <Properties>
      <GridColor type="enumeration">LightGray</GridColor>
      <BaselineColor type="enumeration">LightBlue</BaselineColor>
    </Properties>
  </GridPreference>
  <PasteboardPreference Self="d-PasteboardPreference1"
    PasteboardMargins="1 1" MinimumSpaceAboveAndBelow="36">
    <Properties>
      <PreviewBackgroundColor type="enumeration">LightGray</PreviewBackgroundColor>
      <BleedGuideColor type="enumeration">Fiesta</BleedGuideColor>
      <SlugGuideColor type="enumeration">GridBlue</SlugGuideColor>
    </Properties>
  </PasteboardPreference>
  <StoryPreference Self="d-StoryPreference1"
    OpticalMarginAlignment="false" OpticalMarginSize="12"
    FrameType="TextFrameType" StoryOrientation="Horizontal"
    StoryDirection="LeftToRightDirection"/>
  <TextPreference Self="d-TextPreference1"
    TypographersQuotes="true" HighlightSubstitutedFonts="true"
    UseParagraphLeading="false" SmallCap="70"
    SuperscriptSize="58.3" SuperscriptPosition="33.3"
    SubscriptSize="58.3" SubscriptPosition="33.3"/>
  <TextFramePreference Self="d-TextFramePreference1"
    TextColumnCount="1" TextColumnGutter="12"
    UseFixedColumnWidth="false" FirstBaselineOffset="AscentOffset"
    MinimumFirstBaselineOffset="0" VerticalJustification="TopAlign"
    VerticalThreshold="0" IgnoreWrap="false">
    <Properties>
      <InsetSpacing type="list">
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
        <ListItem type="unit">0</ListItem>
      </InsetSpacing>
    </Properties>
  </TextFramePreference>
  <TextWrapPreference Self="d-TextWrapPreference1"
    TextWrapMode="None" Inverse="false"
    ApplyToMasterPageOnly="false" TextWrapSide="BothSides">
    <Properties>
      <TextWrapOffset Top="0" Left="0" Bottom="0" Right="0"/>
    </Properties>
    <ContourOption Self="d-TextWrapPreference1ContourOption1"
      ContourType="SameAsClipping" IncludeInsideEdges="false"
      ContourPathName="$ID/"/>
  </TextWrapPreference>
  <TransparencyPreference Self="d-TransparencyPreference1"
    BlendingSpace="CMYK" GlobalLightAngle="120" GlobalLightAltitude="30"/>
</idPkg:Preferences>'''


def _build_backing_story():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:BackingStory xmlns:idPkg="{_NS}" DOMVersion="8.0">
  <XmlStory Self="backstory1" AppliedTOCStyle="n" TrackChanges="false"
    StoryTitle="$ID/" AppliedNamedGrid="n">
    <StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12"
      FrameType="TextFrameType" StoryOrientation="Horizontal"
      StoryDirection="LeftToRightDirection"/>
    <InCopyExportOption IncludeGraphicProxies="true" IncludeAllResources="false"/>
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"/>
    </ParagraphStyleRange>
  </XmlStory>
</idPkg:BackingStory>'''


def _build_tags():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Tags xmlns:idPkg="{_NS}" DOMVersion="8.0">
</idPkg:Tags>'''


def _build_mapping():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<idPkg:Mapping xmlns:idPkg="{_NS}" DOMVersion="8.0">
</idPkg:Mapping>'''
