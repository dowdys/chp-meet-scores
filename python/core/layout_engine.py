"""Layout engine for shirt back data computation.

Handles all data queries, name cleaning, level grouping, bin-packing,
and font sizing. Does NOT handle any rendering (no fitz/PyMuPDF imports).
"""

import logging
import re
import sqlite3

from python.core.constants import (
    EVENTS as EVENT_KEYS,
    PAGE_H,
    RED,
    DEFAULT_SPORT, DEFAULT_TITLE_PREFIX, DEFAULT_COPYRIGHT,
    FONT_REGULAR, FONT_BOLD,
    TITLE1_LARGE, TITLE2_LARGE,
    HEADER_LARGE, LEVEL_DIVIDER_SIZE, DEFAULT_NAME_SIZE, MIN_NAME_SIZE,
    LINE_HEIGHT_RATIO, LEVEL_GAP, MAX_PAGE_FILL,
    XCEL_MAP, XCEL_PRESTIGE_ORDER as XCEL_ORDER,
)

logger = logging.getLogger(__name__)


def parse_hex_color(hex_str: str) -> tuple:
    """Parse a hex color string (e.g. '#CC0000' or 'CC0000') to (r, g, b) tuple 0-1."""
    h = hex_str.lstrip('#')
    if len(h) != 6:
        return RED  # fallback
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def compute_layout(t1l=TITLE1_LARGE, t2l=TITLE2_LARGE) -> tuple[float, float, float, float, float]:
    """Compute Y positions for page elements based on title font sizes.

    Returns (title1_y, title2_y, oval_y, headers_y, names_start_y).
    """
    t1_y = 14 + int(t1l)
    t2_y = t1_y + round(t1l * 1.375)
    ov_y = t2_y + round(t2l * 1.2)
    hd_y = ov_y + 24
    ns_y = hd_y + 16
    return t1_y, t2_y, ov_y, hd_y, ns_y


def precompute_shirt_data(db_path: str, meet_name: str, name_sort: str = None,
                          layout=None,
                          level_groups=None, exclude_levels=None,
                          page_h: int = None) -> dict:
    """Pre-compute shirt layout data for reuse across multiple renders.

    Args:
        layout: Optional LayoutParams object. When provided, its field values
            supply all appearance parameters.
        level_groups: Custom page grouping (run-time override, not a layout param).
        exclude_levels: Comma-separated levels to intentionally exclude
            (e.g. "3,4" to drop levels with no real data). Run-time override.
        page_h: Page height override (e.g. legal size). Run-time override.

    Returns a dict with levels, data, page_groups, and resolved layout params.
    """
    # Extract values from layout object when provided, else use defaults
    if layout:
        line_spacing = layout.line_spacing
        level_gap = layout.level_gap
        max_fill = layout.max_fill
        min_font_size = layout.min_font_size
        max_font_size = layout.max_font_size
        max_shirt_pages = layout.max_shirt_pages
        title1_size = layout.title1_size
        title2_size = layout.title2_size
        copyright = layout.copyright
        accent_color = layout.accent_color
        font_family = layout.font_family
        sport = layout.sport
        title_prefix = layout.title_prefix
        header_size = layout.header_size
        divider_size = layout.divider_size
        if name_sort is None:
            name_sort = layout.name_sort
    else:
        line_spacing = None
        level_gap = None
        max_fill = None
        min_font_size = None
        max_font_size = None
        max_shirt_pages = None
        title1_size = None
        title2_size = None
        copyright = None
        accent_color = None
        font_family = None
        sport = None
        title_prefix = None
        header_size = None
        divider_size = None

    # Default to 'age' if still None after merge
    if name_sort is None:
        name_sort = 'age'

    lhr = line_spacing if line_spacing is not None else LINE_HEIGHT_RATIO
    lgap = level_gap if level_gap is not None else LEVEL_GAP
    mfill = max_fill if max_fill is not None else MAX_PAGE_FILL
    mfs = min_font_size if min_font_size is not None else MIN_NAME_SIZE
    mxfs = max_font_size if max_font_size is not None else DEFAULT_NAME_SIZE

    # Title sizes (large/small caps pairs)
    t1l = title1_size if title1_size is not None else TITLE1_LARGE
    t1s = round(t1l * 0.75)
    t2l = title2_size if title2_size is not None else TITLE2_LARGE
    t2s = round(t2l * 0.75)

    # Visual style params
    cr = copyright if copyright is not None else DEFAULT_COPYRIGHT
    sp = sport if sport is not None else DEFAULT_SPORT
    tp = title_prefix if title_prefix is not None else DEFAULT_TITLE_PREFIX
    hl = header_size if header_size is not None else HEADER_LARGE
    hs = round(hl * 0.72)
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    accent = parse_hex_color(accent_color) if accent_color else RED
    if font_family == 'sans-serif':
        f_reg, f_bold = 'Helvetica', 'Helvetica-Bold'
    else:
        f_reg, f_bold = FONT_REGULAR, FONT_BOLD

    # Compute Y positions from title sizes
    title1_y, title2_y, oval_y, headers_y, names_start = compute_layout(t1l, t2l)

    levels, data, _flagged, _modified = get_winners_by_event_and_level(
        db_path, meet_name, name_sort=name_sort)

    # Diagnostic: log all levels found and their athlete counts
    _diag_counts = {}
    for lv in levels:
        _lv_total = sum(len(data[ev].get(lv, [])) for ev in EVENT_KEYS)
        _diag_counts[lv] = _lv_total
    logger.info("SHIRT_DIAG: %d levels found: %s", len(levels), levels)
    logger.info("SHIRT_DIAG: athletes per level: %s", _diag_counts)

    # Intentionally exclude specific levels (e.g. levels with no real data)
    if exclude_levels:
        if isinstance(exclude_levels, str):
            excl = {lv.strip() for lv in exclude_levels.split(',')}
        else:
            excl = set(exclude_levels)
        levels = [lv for lv in levels if lv not in excl]
        for event in EVENT_KEYS:
            for lv in excl:
                data[event].pop(lv, None)
        logger.info("SHIRT_DIAG: after exclusions: %d levels: %s", len(levels), levels)

    style = {
        'copyright': cr, 'sport': sp, 'title_prefix': tp,
        'header_large': hl, 'header_small': hs, 'divider_size': ds,
        'accent_color': accent, 'font_regular': f_reg, 'font_bold': f_bold,
    }

    _page_h = page_h or PAGE_H
    _names_bottom = _page_h - 18

    empty_result = {
        'levels': [], 'data': {}, 'page_groups': [],
        'lhr': lhr, 'lgap': lgap, 'mfill': mfill, 'mfs': mfs, 'mxfs': mxfs,
        't1l': t1l, 't1s': t1s, 't2l': t2l, 't2s': t2s,
        'title1_y': title1_y, 'title2_y': title2_y,
        'oval_y': oval_y, 'headers_y': headers_y,
        'names_start_y': names_start,
        'page_h': _page_h,
        'flagged_names': [], 'modified_names': [],
        **style,
    }

    if not levels:
        return empty_result

    # Classify levels into Xcel and numbered
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

    logger.debug("SHIRT_DIAG: xcel_levels=%s, numbered_levels=%s", xcel_levels, numbered_levels)

    available = (_names_bottom - names_start) * mfill

    # Custom level groups override auto bin-packing
    if level_groups:
        level_set = set(levels)
        logger.debug("SHIRT_DIAG: using custom level_groups=%r, level_set=%s", level_groups, level_set)
        page_groups = parse_level_groups(level_groups, level_set)
        logger.debug("SHIRT_DIAG: parsed page_groups: %s", [(label, lvs) for label, lvs in page_groups])
    else:
        # Auto bin-packing
        page_groups = []
        if xcel_levels:
            xcel_groups = bin_pack_levels(xcel_levels, data, available,
                                          lhr, lgap, mxfs, divider_size=ds)
            for group in xcel_groups:
                page_groups.append(('XCEL', group))

        if numbered_levels:
            groups = bin_pack_levels(numbered_levels, data, available,
                                     lhr, lgap, mxfs, divider_size=ds)
            for group in groups:
                page_groups.append(label_numbered_group(group))

        # If max_shirt_pages is set and we have too many pages, try shrinking
        # the bin-pack font estimate to merge groups. Uses multi-resolution
        # search (1.0 -> 0.5 -> 0.2 -> 0.1) for efficiency.
        if max_shirt_pages and len(page_groups) > max_shirt_pages:
            def _groups_at_size(try_size):
                new_groups = []
                if xcel_levels:
                    for g in bin_pack_levels(xcel_levels, data, available,
                                             lhr, lgap, try_size,
                                             divider_size=ds):
                        new_groups.append(('XCEL', g))
                if numbered_levels:
                    for g in bin_pack_levels(numbered_levels, data, available,
                                             lhr, lgap, try_size,
                                             divider_size=ds):
                        new_groups.append(label_numbered_group(g))
                return new_groups

            best_size = mfs
            best_groups = _groups_at_size(mfs)

            for step in [1.0, 0.5, 0.2, 0.1]:
                candidate = best_size + step
                while candidate <= mxfs + 0.001:
                    candidate_groups = _groups_at_size(candidate)
                    if len(candidate_groups) <= max_shirt_pages:
                        best_size = candidate
                        best_groups = candidate_groups
                        candidate += step
                    else:
                        break

            page_groups = best_groups

    logger.info("SHIRT_DIAG: final page_groups (%d pages): %s",
                len(page_groups), [(label, len(lvs)) for label, lvs in page_groups])

    return {'levels': levels, 'data': data, 'page_groups': page_groups,
            'lhr': lhr, 'lgap': lgap, 'mfill': mfill,
            'mfs': mfs, 'mxfs': mxfs,
            't1l': t1l, 't1s': t1s, 't2l': t2l, 't2s': t2s,
            'title1_y': title1_y, 'title2_y': title2_y,
            'oval_y': oval_y, 'headers_y': headers_y,
            'names_start_y': names_start,
            'page_h': _page_h,
            'flagged_names': _flagged,
            'modified_names': _modified,
            **style}


def label_numbered_group(group: list) -> tuple[str, list]:
    """Derive an oval label from a list of numbered levels."""
    nums = sorted([int(lv) for lv in group if lv.isdigit()])
    if len(nums) >= 2:
        label = f'LEVELS {nums[0]}-{nums[-1]}'
    elif len(nums) == 1:
        label = f'LEVEL {nums[0]}'
    else:
        label = 'LEVELS'
    return (label, group)


def _sort_level_group(levels: list) -> list:
    """Sort levels within a group using three-bucket sort.

    1. Xcel levels — prestige order (Sapphire first, Bronze last)
    2. Other non-numeric levels ("Senior", "2A", "Adults") — original relative order
    3. Numbered levels — descending by int value (10, 9, 8, ...)
    """
    xcel = []
    numbered = []
    other = []
    for lv in levels:
        if XCEL_MAP.get(lv) in XCEL_ORDER:
            xcel.append(lv)
        elif lv.isdigit():
            numbered.append(lv)
        else:
            other.append(lv)  # preserve original order
    xcel.sort(key=lambda x: XCEL_ORDER.index(XCEL_MAP[x]))
    numbered.sort(key=lambda x: -int(x))
    return xcel + other + numbered


def parse_level_groups(level_groups, level_set: set) -> list:
    """Parse custom level groups into page_groups list.

    level_groups: semicolon-separated groups, comma-separated levels.
        E.g. "XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"
    level_set: set of levels that exist in the data.

    Levels within each group are auto-sorted (Xcel prestige, numbered
    descending) regardless of caller input order.  Any levels in level_set
    that are NOT mentioned in level_groups are automatically appended to
    the last group so no winners are silently dropped.
    """
    if isinstance(level_groups, str):
        raw_groups = level_groups.split(';')
    else:
        raw_groups = level_groups

    page_groups = []
    included = set()
    for group_str in raw_groups:
        if isinstance(group_str, str):
            group_levels = [lv.strip() for lv in group_str.split(',')]
        else:
            group_levels = list(group_str)
        # Filter to only levels that exist in the data
        group_levels = [lv for lv in group_levels if lv in level_set]
        if not group_levels:
            continue
        # Auto-sort within group so caller order doesn't matter
        group_levels = _sort_level_group(group_levels)
        included.update(group_levels)
        page_groups.append((label_group(group_levels), group_levels))

    # Auto-include any levels with winners that were not mentioned
    missing = level_set - included
    if missing and page_groups:
        missing_sorted = _sort_level_group(list(missing))
        # Append to last group
        last_label, last_levels = page_groups[-1]
        last_levels.extend(missing_sorted)
        page_groups[-1] = (label_group(last_levels), last_levels)

    return page_groups


def label_group(group_levels: list) -> str:
    """Derive a page label from a list of levels."""
    xcel_in = [lv for lv in group_levels if lv in XCEL_MAP]
    numbered_in = [lv for lv in group_levels if lv not in XCEL_MAP]
    if xcel_in and not numbered_in:
        return 'XCEL'
    elif numbered_in and not xcel_in:
        nums = sorted([int(lv) for lv in numbered_in if lv.isdigit()])
        if len(nums) >= 2:
            return f'LEVELS {nums[0]}-{nums[-1]}'
        elif len(nums) == 1:
            return f'LEVEL {nums[0]}'
        else:
            return 'LEVELS'
    else:
        # Mixed Xcel + numbered
        nums = sorted([int(lv) for lv in numbered_in if lv.isdigit()])
        if nums:
            return f'XCEL & LEVELS {nums[0]}-{nums[-1]}'
        else:
            return 'XCEL'


# --- Data query ---

# Event code patterns used for name cleaning.
# Note: single-char codes V/Be/Fl risk false positives on names ending
# with initials (pre-existing limitation).
_EVENT_CODES = r'(?:VT|UB|BB|FX|BX|Bars?|Beam|BM|Floor|V|Be|Fl|AA|IES)'
_EVENT_CODES_PATTERN = re.compile(
    rf'\s+{_EVENT_CODES}(?:[,\s]+{_EVENT_CODES})*\s*$', re.IGNORECASE)
_DASH_EVENT_PATTERN = re.compile(
    rf'\s*-\s*{_EVENT_CODES}(?:[,\s]+{_EVENT_CODES})*\s*$', re.IGNORECASE)


def clean_name_for_shirt(name: str) -> str:
    """Clean a name for display on the championship shirt.

    Event code stripping is already handled by clean_athlete_name() in db_builder
    at data entry time. This function handles remaining display concerns:
    parenthetical annotations, pronunciation guides, and curly quotes.
    """
    from .db_builder import clean_athlete_name
    # First pass: strip any event codes that survived (defense-in-depth)
    cleaned = clean_athlete_name(name)
    # Remove any remaining parenthetical content: "Name (Ah-nee-uh)" -> "Name"
    cleaned = re.sub(r'\s*\([^)]*\)\s*', '', cleaned)
    # Remove curly-quote pronunciation: "Name\u201cpronunciation\u201d" -> "Name"
    cleaned = re.sub(r'\s*[\u201c][^\u201d]*[\u201d]', '', cleaned)
    return cleaned.strip()


def flag_suspicious_name(name: str) -> str:
    """Check if a cleaned name still looks suspicious. Returns a reason
    string if suspicious, or empty string if it looks normal.
    """
    if not name:
        return 'empty name'
    # Single word names (might be missing first or last name)
    if ' ' not in name.strip():
        return 'single word (missing first or last name?)'
    # Contains digits (might have scores or numbers appended)
    if re.search(r'\d', name):
        return 'contains digits (score or number in name?)'
    # Very long name (>35 chars might have extra data)
    if len(name) > 40:
        return f'unusually long ({len(name)} chars)'
    # Ends with all-caps word that's 2-3 chars (might be an event code we missed)
    last_word = name.split()[-1]
    if len(last_word) <= 3 and last_word.isupper() and last_word not in ('II', 'III', 'IV', 'Jr', 'JR', 'SR'):
        return f'ends with "{last_word}" (event code?)'
    # Contains common event/score patterns we might have missed
    if re.search(r'\b(?:IES|spec|vault|bars|beam|floor)\b', name, re.IGNORECASE):
        return 'contains event keyword'
    return ''


def get_winners_by_event_and_level(db_path: str, meet_name: str,
                                   name_sort: str = 'age') -> tuple[list, dict, list, list]:
    """Get winner names organized by event and level.

    Args:
        name_sort: 'age' sorts by division age group (youngest first), then
                   alphabetically within each group. 'alpha' sorts purely
                   alphabetically ignoring divisions.
    """
    from python.core.division_detector import detect_division_order

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        flagged = []   # (cleaned_name, raw_name, event, level, reason)
        modified = []  # (raw_name, cleaned_name, event, level)

        cur.execute('''SELECT DISTINCT level FROM winners
                       WHERE meet_name = ?''', (meet_name,))
        levels = [row[0] for row in cur.fetchall()]
        logger.debug("WINNERS_DIAG: db=%s", db_path)
        logger.debug("WINNERS_DIAG: meet_name=%r, found %d levels: %s", meet_name, len(levels), levels)

        # Get division ordering for age-based sort
        div_order, _unknowns = detect_division_order(db_path, meet_name)
        logger.debug("WINNERS_DIAG: div_order has %d entries: %s", len(div_order), div_order)

        # Build score lookups keyed by (name, level, session) for tie-breaking.
        # Tie-breaking only applies within the same division+session.
        aa_scores = {}          # (name, level, session) -> AA score
        event_scores = {}       # (name, level, session) -> sorted [highest, next, ...] event scores
        try:
            cur.execute('''SELECT name, level, session, vault, bars, beam, floor, aa FROM results
                           WHERE meet_name = ?''',
                        (meet_name,))
            for name, level, session, vault, bars, beam, floor, aa in cur.fetchall():
                key = (name, level, session)
                # AA score for event tie-breaking
                if aa and aa > 0:
                    if key not in aa_scores or aa > aa_scores[key]:
                        aa_scores[key] = aa
                # Individual event scores sorted descending for AA tie-breaking
                # Rule: AA ties broken by highest single event score, then next highest, etc.
                scores = sorted(
                    [s for s in (vault, bars, beam, floor) if s and s > 0],
                    reverse=True
                )
                event_scores[key] = scores
        except Exception:
            pass  # results table may not exist or have different schema

        # Helper to parse session as int for sorting (fall back to string)
        def _session_sort_key(s):
            try:
                return (0, int(s))
            except (ValueError, TypeError):
                return (1, s or '')

        data = {}
        for event in EVENT_KEYS:
            data[event] = {}
            for level in levels:
                # Get names with their division AND session for sorting
                cur.execute('''SELECT DISTINCT name, division, session FROM winners
                              WHERE meet_name = ? AND event = ? AND level = ?''',
                            (meet_name, event, level))
                rows = cur.fetchall()
                if rows:
                    # Safety net: log divisions not found in div_order
                    _row_divs = {r[1] for r in rows if r[1]}
                    _unmatched = _row_divs - set(div_order.keys())
                    if _unmatched:
                        logger.debug("ORDERING_DIAG: L%s %s: %d winner divisions "
                                     "not in div_order: %s",
                                     level, event, len(_unmatched), _unmatched)

                    if name_sort == 'alpha':
                        rows.sort(key=lambda r: r[0])
                    else:
                        # Sort by: 1) division age (youngest first),
                        #          2) session ascending,
                        #          3) for event ties: AA score descending,
                        #          4) for AA ties: highest individual event score descending,
                        #             then next highest, etc.
                        #          5) name alphabetically
                        def _tiebreak_key(r):
                            key = (r[0], level, r[2])
                            aa = aa_scores.get(key, -1)
                            # Negate individual event scores for descending sort
                            # Pad to 4 elements so tuples are always comparable
                            scores = event_scores.get(key, [])
                            neg_scores = tuple(-s for s in scores) + (0, 0, 0, 0)
                            return (
                                div_order.get(r[1], 99),
                                _session_sort_key(r[2]),
                                -aa,
                                neg_scores[:4],
                                r[0]
                            )
                        rows.sort(key=_tiebreak_key)
                    # Clean names for shirt display (strip parenthetical annotations)
                    seen = set()
                    clean_names = []
                    for r in rows:
                        raw = r[0]
                        cleaned = clean_name_for_shirt(raw)
                        if cleaned and cleaned not in seen:
                            seen.add(cleaned)
                            clean_names.append(cleaned)
                            # Flag suspicious names
                            reason = flag_suspicious_name(cleaned)
                            if reason:
                                flagged.append((cleaned, raw, event, level, reason))
                            elif cleaned != raw.strip():
                                # Name was modified by cleaning -- note it
                                modified.append((raw.strip(), cleaned, event, level))
                    data[event][level] = clean_names
    finally:
        conn.close()

    return levels, data, flagged, modified


# --- Layout helpers ---

def level_height(level: str, data: dict, line_height: float,
                 level_gap: float, divider_size: float = None) -> float:
    """Calculate the vertical space one level needs."""
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    max_names = max(len(data[event].get(level, [])) for event in EVENT_KEYS)
    return level_gap + ds * 1.3 + max_names * line_height + 1


def bin_pack_levels(levels: list, data: dict, available_height: float,
                    line_height_ratio: float = LINE_HEIGHT_RATIO,
                    level_gap: float = LEVEL_GAP,
                    max_font_size: float = DEFAULT_NAME_SIZE,
                    divider_size: float = None) -> list:
    """Bin-pack levels into page-sized groups with balanced distribution.

    Two-pass approach:
    1. Greedy pack to find the actual minimum page count (accounts for
       large levels that can't combine with others).
    2. Balanced redistribution targeting equal height per page, so the
       last page isn't nearly empty.
    """
    line_height = max_font_size * line_height_ratio

    # Calculate height for each level
    heights = []
    for lv in levels:
        h = level_height(lv, data, line_height, level_gap, divider_size=divider_size)
        heights.append(h)

    total = sum(heights)
    if total <= available_height:
        return [levels]

    # Pass 1: greedy pack to find actual page count
    greedy_pages = []
    current = []
    current_h = 0
    for i, lv in enumerate(levels):
        h = heights[i]
        if current and current_h + h > available_height:
            greedy_pages.append(current)
            current = [lv]
            current_h = h
        else:
            current.append(lv)
            current_h += h
    if current:
        greedy_pages.append(current)

    num_pages = len(greedy_pages)
    if num_pages <= 1:
        return greedy_pages

    # Pass 2: balanced redistribution
    target = total / num_pages

    balanced_pages = []
    current = []
    current_h = 0
    remaining_pages = num_pages

    for i, lv in enumerate(levels):
        h = heights[i]
        remaining_levels = len(levels) - i

        if current and remaining_pages > 1:
            over_target = current_h >= target * 0.85
            would_overflow = current_h + h > available_height
            enough_left = remaining_levels >= remaining_pages
            if (over_target and enough_left) or would_overflow:
                balanced_pages.append(current)
                current = []
                current_h = 0
                remaining_pages -= 1

        current.append(lv)
        current_h += h

    if current:
        balanced_pages.append(current)
    return balanced_pages


def fit_font_size(levels: list, data: dict,
                  line_height_ratio: float = LINE_HEIGHT_RATIO,
                  level_gap: float = LEVEL_GAP,
                  max_page_fill: float = MAX_PAGE_FILL,
                  min_name_size: float = MIN_NAME_SIZE,
                  max_font_size: float = DEFAULT_NAME_SIZE,
                  names_start_y: float = None,
                  divider_size: float = None,
                  page_h: int = None) -> float:
    """Find the largest font size that fits all levels on page.

    Uses multi-resolution search (like a B-tree index): tests at
    progressively finer steps (1.0 -> 0.5 -> 0.2 -> 0.1) instead
    of scanning every 0.1 increment linearly. Precise to 0.1pt.
    """
    if names_start_y is None:
        names_start_y = 121  # default from compute_layout()
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    _names_bottom = (page_h or PAGE_H) - 18
    available = (_names_bottom - names_start_y) * max_page_fill

    def _total_height(size):
        lh = size * line_height_ratio
        return sum(
            level_gap + ds * 1.3 +
            max(len(data[event].get(lv, [])) for event in EVENT_KEYS) * lh + 1
            for lv in levels
        )

    # Quick check: if max fits, use it
    if _total_height(max_font_size) <= available:
        return max_font_size

    # Quick check: if min doesn't fit, use min anyway
    if _total_height(min_name_size) > available:
        return min_name_size

    # Multi-resolution search: start at min (definitely fits) and
    # step upward at progressively finer increments
    best = min_name_size
    for step in [1.0, 0.5, 0.2, 0.1]:
        candidate = best + step
        while candidate <= max_font_size + 0.001:
            if _total_height(candidate) <= available:
                best = candidate
                candidate += step
            else:
                break

    return round(best, 1)


def space_text(text: str) -> str:
    """Add letter spacing: 'LEVEL 10' -> 'L E V E L  1 0'."""
    words = text.split()
    spaced_words = [' '.join(list(word)) for word in words]
    return '  '.join(spaced_words)


def get_winners_with_gym(db_path: str, meet_name: str) -> dict:
    """Get a mapping of winner name -> gym (with cleaned names)."""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute('SELECT DISTINCT name, gym FROM winners WHERE meet_name = ?',
                    (meet_name,))
        result = {}
        for row in cur.fetchall():
            cleaned = clean_name_for_shirt(row[0])
            if cleaned:
                if cleaned in result and result[cleaned] != row[1]:
                    # Name collision: same cleaned name at different gyms.
                    # Keep the first gym but warn so the issue is visible.
                    logger.warning('NAME_COLLISION: "%s" appears at both "%s" and "%s" - using first gym',
                                   cleaned, result[cleaned], row[1])
                elif cleaned not in result:
                    result[cleaned] = row[1]
    finally:
        conn.close()
    return result


def get_all_winner_gyms(db_path: str, meet_name: str) -> list:
    """Get sorted list of all gyms that have winners."""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute('SELECT DISTINCT gym FROM winners WHERE meet_name = ? ORDER BY gym',
                    (meet_name,))
        result = [row[0] for row in cur.fetchall()]
    finally:
        conn.close()
    return result
