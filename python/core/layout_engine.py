"""Layout engine for shirt back data computation.

Handles all data queries, name cleaning, level grouping, bin-packing,
and font sizing. Does NOT handle any rendering (no fitz/PyMuPDF imports).
"""

import re
import sqlite3

from python.core.constants import (
    EVENTS as EVENT_KEYS,
    PAGE_H, PAGE_H_LEGAL,
    RED,
    DEFAULT_SPORT, DEFAULT_TITLE_PREFIX, DEFAULT_COPYRIGHT,
    FONT_REGULAR, FONT_BOLD,
    TITLE1_LARGE, TITLE2_LARGE,
    HEADER_LARGE, LEVEL_DIVIDER_SIZE, DEFAULT_NAME_SIZE, MIN_NAME_SIZE,
    LINE_HEIGHT_RATIO, LEVEL_GAP, MAX_PAGE_FILL,
    XCEL_MAP, XCEL_PRESTIGE_ORDER as XCEL_ORDER,
)


def _parse_hex_color(hex_str):
    """Parse a hex color string (e.g. '#CC0000' or 'CC0000') to (r, g, b) tuple 0-1."""
    h = hex_str.lstrip('#')
    if len(h) != 6:
        return RED  # fallback
    return (int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)


def _compute_layout(t1l=TITLE1_LARGE, t2l=TITLE2_LARGE):
    """Compute Y positions for page elements based on title font sizes.

    Returns (title1_y, title2_y, oval_y, headers_y, names_start_y).
    """
    t1_y = 14 + int(t1l)
    t2_y = t1_y + round(t1l * 1.375)
    ov_y = t2_y + round(t2l * 1.2)
    hd_y = ov_y + 24
    ns_y = hd_y + 16
    return t1_y, t2_y, ov_y, hd_y, ns_y


def precompute_shirt_data(db_path, meet_name, name_sort='age',
                          layout=None,  # LayoutParams object
                          line_spacing=None, level_gap=None,
                          max_fill=None, min_font_size=None,
                          max_font_size=None, max_shirt_pages=None,
                          title1_size=None, title2_size=None,
                          level_groups=None, exclude_levels=None,
                          copyright=None, accent_color=None,
                          font_family=None, sport=None,
                          title_prefix=None, header_size=None,
                          divider_size=None, page_h=None):
    """Pre-compute shirt layout data for reuse across multiple renders.

    Args:
        layout: Optional LayoutParams object. When provided, its values are
            used as defaults (individual kwargs still override).
        exclude_levels: Comma-separated levels to intentionally exclude
            (e.g. "3,4" to drop levels with no real data). Without this,
            all levels with winners are included.

    Returns a dict with levels, data, page_groups, and resolved layout params.
    """
    # If layout is provided, use its values as defaults (kwargs override)
    if layout:
        line_spacing = line_spacing if line_spacing is not None else layout.line_spacing
        level_gap = level_gap if level_gap is not None else layout.level_gap
        max_fill = max_fill if max_fill is not None else layout.max_fill
        min_font_size = min_font_size if min_font_size is not None else layout.min_font_size
        max_font_size = max_font_size if max_font_size is not None else layout.max_font_size
        max_shirt_pages = max_shirt_pages if max_shirt_pages is not None else layout.max_shirt_pages
        title1_size = title1_size if title1_size is not None else layout.title1_size
        title2_size = title2_size if title2_size is not None else layout.title2_size
        copyright = copyright if copyright is not None else layout.copyright
        accent_color = accent_color if accent_color is not None else layout.accent_color
        font_family = font_family if font_family is not None else layout.font_family
        sport = sport if sport is not None else layout.sport
        title_prefix = title_prefix if title_prefix is not None else layout.title_prefix
        header_size = header_size if header_size is not None else layout.header_size
        divider_size = divider_size if divider_size is not None else layout.divider_size
        name_sort = name_sort if name_sort != 'age' else layout.name_sort

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
    accent = _parse_hex_color(accent_color) if accent_color else RED
    if font_family == 'sans-serif':
        f_reg, f_bold = 'Helvetica', 'Helvetica-Bold'
    else:
        f_reg, f_bold = FONT_REGULAR, FONT_BOLD

    # Compute Y positions from title sizes
    title1_y, title2_y, oval_y, headers_y, names_start = _compute_layout(t1l, t2l)

    levels, data, _flagged, _modified = _get_winners_by_event_and_level(
        db_path, meet_name, name_sort=name_sort)

    # Diagnostic: log all levels found and their athlete counts
    _diag_counts = {}
    for lv in levels:
        _lv_total = sum(len(data[ev].get(lv, [])) for ev in EVENT_KEYS)
        _diag_counts[lv] = _lv_total
    print(f"SHIRT_DIAG: {len(levels)} levels found: {levels}")
    print(f"SHIRT_DIAG: athletes per level: {_diag_counts}")

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
        print(f"SHIRT_DIAG: after exclusions: {len(levels)} levels: {levels}")

    style = {
        'copyright': cr, 'sport': sp, 'title_prefix': tp,
        'header_large': hl, 'header_small': hs, 'divider_size': ds,
        'accent_color': accent, 'font_regular': f_reg, 'font_bold': f_bold,
    }

    empty_result = {
        'levels': [], 'data': {}, 'page_groups': [],
        'lhr': lhr, 'lgap': lgap, 'mfill': mfill, 'mfs': mfs, 'mxfs': mxfs,
        't1l': t1l, 't1s': t1s, 't2l': t2l, 't2s': t2s,
        'title1_y': title1_y, 'title2_y': title2_y,
        'oval_y': oval_y, 'headers_y': headers_y,
        'names_start_y': names_start,
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

    print(f"SHIRT_DIAG: xcel_levels={xcel_levels}, numbered_levels={numbered_levels}")

    _page_h = page_h or PAGE_H
    _names_bottom = _page_h - 18
    available = (_names_bottom - names_start) * mfill

    # Custom level groups override auto bin-packing
    if level_groups:
        level_set = set(levels)
        print(f"SHIRT_DIAG: using custom level_groups={level_groups!r}, level_set={level_set}")
        page_groups = _parse_level_groups(level_groups, level_set)
        print(f"SHIRT_DIAG: parsed page_groups: {[(label, lvs) for label, lvs in page_groups]}")
    else:
        # Auto bin-packing
        page_groups = []
        if xcel_levels:
            xcel_groups = _bin_pack_levels(xcel_levels, data, available,
                                           lhr, lgap, mxfs, divider_size=ds)
            for group in xcel_groups:
                page_groups.append(('XCEL', group))

        if numbered_levels:
            groups = _bin_pack_levels(numbered_levels, data, available,
                                      lhr, lgap, mxfs, divider_size=ds)
            for group in groups:
                page_groups.append(_label_numbered_group(group))

        # If max_shirt_pages is set and we have too many pages, try shrinking
        # the bin-pack font estimate to merge groups. Uses multi-resolution
        # search (1.0 -> 0.5 -> 0.2 -> 0.1) for efficiency.
        if max_shirt_pages and len(page_groups) > max_shirt_pages:
            def _groups_at_size(try_size):
                new_groups = []
                if xcel_levels:
                    for g in _bin_pack_levels(xcel_levels, data, available,
                                              lhr, lgap, try_size,
                                              divider_size=ds):
                        new_groups.append(('XCEL', g))
                if numbered_levels:
                    for g in _bin_pack_levels(numbered_levels, data, available,
                                              lhr, lgap, try_size,
                                              divider_size=ds):
                        new_groups.append(_label_numbered_group(g))
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

    print(f"SHIRT_DIAG: final page_groups ({len(page_groups)} pages): "
          f"{[(label, len(lvs)) for label, lvs in page_groups]}")

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


def _label_numbered_group(group):
    """Derive an oval label from a list of numbered levels."""
    nums = sorted([int(lv) for lv in group if lv.isdigit()])
    if len(nums) >= 2:
        label = f'LEVELS {nums[0]}-{nums[-1]}'
    elif len(nums) == 1:
        label = f'LEVEL {nums[0]}'
    else:
        label = 'LEVELS'
    return (label, group)


def _parse_level_groups(level_groups, level_set):
    """Parse custom level groups into page_groups list.

    level_groups: semicolon-separated groups, comma-separated levels.
        E.g. "XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"
    level_set: set of levels that exist in the data.

    Any levels in level_set that are NOT mentioned in level_groups are
    automatically appended to the last group so no winners are silently
    dropped.
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
        included.update(group_levels)
        page_groups.append((_label_group(group_levels), group_levels))

    # Auto-include any levels with winners that were not mentioned
    missing = level_set - included
    if missing and page_groups:
        # Sort missing levels consistently: numbered descending, then Xcel
        missing_xcel = sorted([lv for lv in missing if lv in XCEL_MAP],
                               key=lambda lv: XCEL_ORDER.index(XCEL_MAP[lv])
                               if XCEL_MAP.get(lv) in XCEL_ORDER else 99)
        missing_numbered = sorted([lv for lv in missing if lv not in XCEL_MAP],
                                   key=lambda lv: -int(lv) if lv.isdigit() else 0)
        missing_sorted = missing_numbered + missing_xcel
        # Append to last group
        last_label, last_levels = page_groups[-1]
        last_levels.extend(missing_sorted)
        page_groups[-1] = (_label_group(last_levels), last_levels)

    return page_groups


def _label_group(group_levels):
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

# Event code patterns used for name cleaning
_EVENT_CODES = r'(?:VT|UB|BB|FX|BX|V|Be|Fl|AA|IES)'
_EVENT_CODES_PATTERN = re.compile(
    rf'\s+{_EVENT_CODES}(?:[,\s]+{_EVENT_CODES})*\s*$', re.IGNORECASE)
_DASH_EVENT_PATTERN = re.compile(
    rf'\s*-\s*{_EVENT_CODES}(?:[,\s]+{_EVENT_CODES})*\s*$', re.IGNORECASE)


def _clean_name_for_shirt(name: str) -> str:
    """Strip parenthetical annotations, pronunciation guides, and event
    suffixes from an athlete name before putting it on the shirt.

    Handles: "(Ah-nee-uh)", "(VT UB BB FX)", "Name VT UB", "Name - FX", etc.
    """
    # Remove trailing asterisk + parens first: "Name*(V,BB)" -> "Name"
    cleaned = re.sub(r'\s*\*\s*\([^)]*\)\s*$', '', name)
    # Remove any remaining parenthetical content: "Name (anything)" -> "Name"
    cleaned = re.sub(r'\s*\([^)]*\)\s*', '', cleaned)
    # Remove curly-quote pronunciation: "Name\u201cpronunciation\u201d" -> "Name"
    cleaned = re.sub(r'\s*[\u201c][^\u201d]*[\u201d]', '', cleaned)
    # Remove trailing standalone asterisk
    cleaned = re.sub(r'\s*\*\s*$', '', cleaned)
    # Remove trailing event codes with dash: "Name - VT, FX" -> "Name"
    cleaned = _DASH_EVENT_PATTERN.sub('', cleaned)
    # Remove bare trailing event codes: "Name VT UB BB FX" -> "Name"
    cleaned = _EVENT_CODES_PATTERN.sub('', cleaned)
    return cleaned.strip()


def _flag_suspicious_name(name: str) -> str:
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


def _get_winners_by_event_and_level(db_path: str, meet_name: str,
                                    name_sort: str = 'age'):
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
        print(f"WINNERS_DIAG: db={db_path}")
        print(f"WINNERS_DIAG: meet_name={meet_name!r}, found {len(levels)} levels: {levels}")

        # Get division ordering for age-based sort
        div_order, _unknowns = detect_division_order(db_path, meet_name)

        # Build AA score lookup keyed by (name, level, session) for tie-breaking.
        # AA tie-breaking only applies within the same division+session.
        aa_scores = {}
        try:
            cur.execute('''SELECT name, level, session, aa FROM results
                           WHERE meet_name = ? AND aa IS NOT NULL AND aa > 0''',
                        (meet_name,))
            for name, level, session, aa in cur.fetchall():
                key = (name, level, session)
                if key not in aa_scores or aa > aa_scores[key]:
                    aa_scores[key] = aa
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
                    if name_sort == 'alpha':
                        rows.sort(key=lambda r: r[0])
                    else:
                        # Sort by: 1) division age (youngest first),
                        #          2) session ascending,
                        #          3) AA score descending (only meaningful within
                        #             same division+session for tie-breaking),
                        #          4) name alphabetically
                        rows.sort(key=lambda r: (
                            div_order.get(r[1], 99),
                            _session_sort_key(r[2]),
                            -(aa_scores.get((r[0], level, r[2]), -1)),
                            r[0]
                        ))
                    # Clean names for shirt display (strip parenthetical annotations)
                    seen = set()
                    clean_names = []
                    for r in rows:
                        raw = r[0]
                        cleaned = _clean_name_for_shirt(raw)
                        if cleaned and cleaned not in seen:
                            seen.add(cleaned)
                            clean_names.append(cleaned)
                            # Flag suspicious names
                            reason = _flag_suspicious_name(cleaned)
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

def _level_height(level, data, line_height, level_gap, divider_size=None):
    """Calculate the vertical space one level needs."""
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    max_names = max(len(data[event].get(level, [])) for event in EVENT_KEYS)
    return level_gap + ds * 1.3 + max_names * line_height + 1


def _bin_pack_levels(levels, data, available_height,
                     line_height_ratio=LINE_HEIGHT_RATIO,
                     level_gap=LEVEL_GAP,
                     max_font_size=DEFAULT_NAME_SIZE,
                     divider_size=None):
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
    for level in levels:
        h = _level_height(level, data, line_height, level_gap, divider_size=divider_size)
        heights.append(h)

    total = sum(heights)
    if total <= available_height:
        return [levels]

    # Pass 1: greedy pack to find actual page count
    greedy_pages = []
    current = []
    current_h = 0
    for i, level in enumerate(levels):
        h = heights[i]
        if current and current_h + h > available_height:
            greedy_pages.append(current)
            current = [level]
            current_h = h
        else:
            current.append(level)
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

    for i, level in enumerate(levels):
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

        current.append(level)
        current_h += h

    if current:
        balanced_pages.append(current)
    return balanced_pages


def _fit_font_size(levels, data,
                   line_height_ratio=LINE_HEIGHT_RATIO,
                   level_gap=LEVEL_GAP,
                   max_page_fill=MAX_PAGE_FILL,
                   min_name_size=MIN_NAME_SIZE,
                   max_font_size=DEFAULT_NAME_SIZE,
                   names_start_y=None,
                   divider_size=None,
                   page_h=None):
    """Find the largest font size that fits all levels on page.

    Uses multi-resolution search (like a B-tree index): tests at
    progressively finer steps (1.0 -> 0.5 -> 0.2 -> 0.1) instead
    of scanning every 0.1 increment linearly. Precise to 0.1pt.
    """
    if names_start_y is None:
        names_start_y = 121  # default from _compute_layout()
    ds = divider_size if divider_size is not None else LEVEL_DIVIDER_SIZE
    _names_bottom = (page_h or PAGE_H) - 18
    available = (_names_bottom - names_start_y) * max_page_fill

    def _total_height(size):
        lh = size * line_height_ratio
        return sum(
            level_gap + ds * 1.3 +
            max(len(data[event].get(level, [])) for event in EVENT_KEYS) * lh + 1
            for level in levels
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


def _space_text(text):
    """Add letter spacing: 'LEVEL 10' -> 'L E V E L  1 0'."""
    words = text.split()
    spaced_words = [' '.join(list(word)) for word in words]
    return '  '.join(spaced_words)


def _get_winners_with_gym(db_path, meet_name):
    """Get a mapping of winner name -> gym (with cleaned names)."""
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute('SELECT DISTINCT name, gym FROM winners WHERE meet_name = ?',
                    (meet_name,))
        result = {}
        for row in cur.fetchall():
            cleaned = _clean_name_for_shirt(row[0])
            if cleaned:
                if cleaned in result and result[cleaned] != row[1]:
                    # Name collision: same cleaned name at different gyms.
                    # Keep the first gym but warn so the issue is visible.
                    print(f"NAME_COLLISION: \"{cleaned}\" appears at both "
                          f"\"{result[cleaned]}\" and \"{row[1]}\" - using first gym")
                elif cleaned not in result:
                    result[cleaned] = row[1]
    finally:
        conn.close()
    return result


def _get_all_winner_gyms(db_path, meet_name):
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
