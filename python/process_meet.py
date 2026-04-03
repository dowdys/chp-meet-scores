#!/usr/bin/env python3
"""CLI entry point for processing a gymnastics meet.

Usage:
    python process_meet.py --source scorecat --data ia_athletes.json \\
        --state Iowa --meet "2025 Iowa Dev State Championships" \\
        --association USAG --output ./output/
"""

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import zipfile

# --- Early-exit helper modes (before heavy imports) ---
# These let the bundled binary serve as a general Python runner for the agent.

if len(sys.argv) >= 3 and sys.argv[1] == '--exec-script':
    # Execute an arbitrary Python script file.
    # Environment variables DB_PATH, DATA_DIR, STAGING_DB_PATH are expected.
    script_path = sys.argv[2]
    with open(script_path, 'r', encoding='utf-8') as _f:
        _code = _f.read()
    exec(compile(_code, script_path, 'exec'), {'__name__': '__main__', '__file__': script_path})
    sys.exit(0)

if len(sys.argv) >= 3 and sys.argv[1] == '--render-pdf':
    # Render a PDF page as base64-encoded PNG to stdout.
    import fitz  # PyMuPDF (bundled in PyInstaller binary)
    import base64
    _pdf_path = sys.argv[2]
    _page_num = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    _doc = fitz.open(_pdf_path)
    try:
        if _page_num < 1 or _page_num > len(_doc):
            print(f"Error: Page {_page_num} out of range (PDF has {len(_doc)} pages)")
            sys.exit(1)
        _page = _doc[_page_num - 1]
        _pix = _page.get_pixmap(dpi=200)
        _png_bytes = _pix.tobytes("png")
        print(base64.b64encode(_png_bytes).decode('ascii'))
    finally:
        _doc.close()
    sys.exit(0)

# Add parent directory to path for imports (skip when frozen by PyInstaller)
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python.core.models import MeetConfig, LayoutParams
from python.core.db_builder import build_database
from python.core.output_generator import generate_order_forms
from python.core.pdf_generator import (
    generate_shirt_pdf, generate_gym_highlights_pdf,
    generate_gym_highlights_from_pdf,
)
from python.core.layout_engine import precompute_shirt_data
from python.core.constants import PAGE_H_LEGAL
from python.core.idml_generator import generate_shirt_idml
from python.core.idml_parser import idml_to_pdf, _load_metadata as _peek_metadata
from python.core.meet_summary import generate_meet_summary
from python.core.order_form_generator import generate_order_forms_pdf
from python.core.gym_normalizer import normalize as normalize_gyms, print_gym_report
from python.adapters.scorecat_adapter import ScoreCatAdapter
from python.adapters.html_adapter import HtmlAdapter
from python.adapters.pdf_adapter import PdfAdapter
from python.adapters.generic_adapter import GenericAdapter
from python.core.division_detector import get_division_order, detect_division_order, detect_division_gaps


def _parse_division_order(order_str):
    """Parse a comma-separated division order string into a list of stripped strings.

    Returns None if order_str is falsy, so callers can distinguish
    "no order specified" from an empty list.
    """
    if not order_str or not order_str.strip():
        return None
    result = [s.strip() for s in order_str.split(',') if s.strip()]
    return result if result else None


def _tmp_path_for(output_path):
    """Create a temp file path in the same directory as output_path."""
    dir_name = os.path.dirname(output_path) or '.'
    _, ext = os.path.splitext(output_path)
    fd, tmp = tempfile.mkstemp(suffix=ext, dir=dir_name)
    os.close(fd)
    return tmp


def _safe_move(tmp_path, final_path):
    """Move tmp_path → final_path, handling Windows file-locking gracefully.

    Strategy: try os.replace first (atomic). If that fails due to OneDrive
    or file locks, fall back to shutil.copy2 which overwrites file contents
    without requiring exclusive access. Only uses _NEW pattern as last resort.
    """
    import time
    # Strategy 1: atomic replace (fastest, works when file isn't locked)
    try:
        os.replace(tmp_path, final_path)
        return final_path
    except PermissionError:
        pass

    # Strategy 2: wait for OneDrive sync, then try again
    time.sleep(2)
    try:
        os.replace(tmp_path, final_path)
        return final_path
    except PermissionError:
        pass

    # Strategy 3: copy contents over existing file (works even with OneDrive sync)
    try:
        import shutil
        shutil.copy2(tmp_path, final_path)
        try:
            os.remove(tmp_path)
        except OSError:
            pass
        return final_path
    except PermissionError:
        dir_name = os.path.dirname(final_path)
        base, ext = os.path.splitext(os.path.basename(final_path))
        new_path = os.path.join(dir_name, f'{base}_NEW{ext}')
        # Remove stale _NEW file if it exists
        if os.path.exists(new_path):
            try:
                os.remove(new_path)
            except OSError:
                pass
        os.replace(tmp_path, new_path)
        print(f"WARNING: {os.path.basename(final_path)} is open in another app. "
              f"Saved as {os.path.basename(new_path)} instead -close the original "
              f"and rename when ready.")
        return new_path


def main():
    parser = argparse.ArgumentParser(description='Process a gymnastics meet')
    parser.add_argument('--source',
                        choices=['scorecat', 'mso_pdf', 'mso_html', 'generic'],
                        help='Data source type (required unless --regenerate)')
    parser.add_argument('--data', nargs='+', help='Input data file(s) (required unless --regenerate)')
    parser.add_argument('--state', required=False, default=None, help='State name')
    parser.add_argument('--state-abbrev', default=None,
                        help='State abbreviation for order form logo/template (e.g. "NV", "CA - NorCal"). '
                             'If not provided, uses --state value.')
    parser.add_argument('--meet', required=False, default=None, help='Meet name')
    parser.add_argument('--association', default='USAG',
                        choices=['USAG', 'AAU'], help='Association')
    parser.add_argument('--output', required=True, help='Output directory for generated files')
    parser.add_argument('--db', required=False, default=None,
                        help='Path to the central SQLite database (default: {output}/meet_results.db)')
    parser.add_argument('--strip-parenthetical', action='store_true',
                        help='Strip parenthetical event notations from names (for mso_html)')
    parser.add_argument('--title-line1', default='', help='Shirt PDF title line 1')
    parser.add_argument('--title-line2', default='', help='Shirt PDF title line 2')
    parser.add_argument('--title-line3', default='', help='Shirt PDF title line 3')
    parser.add_argument('--shirt-format', default='event_first',
                        choices=['level_first', 'event_first'],
                        help='Back-of-shirt grouping format')
    parser.add_argument('--shirt-title', default=None,
                        help='Title for level_first shirt format')
    parser.add_argument('--year', default=None,
                        help='Championship year for PDF titles (default: auto from meet name, else current year)')
    parser.add_argument('--gym-map', default=None,
                        help='Path to JSON file mapping gym name aliases to canonical names')
    parser.add_argument('--line-spacing', type=float, default=None,
                        help='Line height ratio for shirt PDF (default 1.15). Lower = tighter.')
    parser.add_argument('--level-gap', type=float, default=None,
                        help='Vertical gap before each level section in shirt PDF (default 6).')
    parser.add_argument('--max-fill', type=float, default=None,
                        help='Max page fill fraction for shirt PDF (default 0.90). E.g. 0.85 = 85%%.')
    parser.add_argument('--min-font-size', type=float, default=None,
                        help='Minimum name font size in points for shirt PDF (default 6.5).')
    parser.add_argument('--max-font-size', type=float, default=None,
                        help='Maximum/starting name font size in points for shirt PDF (default 9). Raise for meets with few winners.')
    parser.add_argument('--name-sort', default='age',
                        choices=['age', 'alpha'],
                        help='Name sort order on shirt PDF: "age" (default) sorts by division age group youngest-first, "alpha" sorts alphabetically.')
    parser.add_argument('--postmark-date', default='TBD',
                        help='Postmark deadline date for order forms (e.g. "March 15, 2026")')
    parser.add_argument('--online-date', default='TBD',
                        help='Online ordering deadline date for order forms (e.g. "March 20, 2026")')
    parser.add_argument('--ship-date', default='TBD',
                        help='Shipping date for order forms (e.g. "April 5, 2026")')
    parser.add_argument('--max-shirt-pages', type=int, default=None,
                        help='Target maximum total pages for back-of-shirt PDF. '
                             'Bin-packer will shrink font estimate to fit within this limit.')
    parser.add_argument('--title1-size', type=float, default=None,
                        help='Font size for title line 1 "{Year} GYMNASTICS" (default 18). '
                             'Larger values make the title more prominent.')
    parser.add_argument('--title2-size', type=float, default=None,
                        help='Font size for title line 2 "STATE CHAMPIONS OF {STATE}" (default 20).')
    parser.add_argument('--level-groups', default=None,
                        help='Custom level grouping for shirt pages. Semicolon-separated groups, '
                             'comma-separated levels within each group. Overrides auto bin-packing. '
                             'Any levels with winners NOT listed are auto-appended to the last group. '
                             'E.g. "XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"')
    parser.add_argument('--exclude-levels', default=None,
                        help='Comma-separated levels to intentionally exclude from the shirt. '
                             'Use for levels with no real data (e.g. "3,4" if those levels had '
                             'no scores). Excluded levels will not appear even with auto-grouping.')
    parser.add_argument('--copyright', default=None,
                        help='Copyright footer text (default "\u00a9 C. H. Publishing")')
    parser.add_argument('--accent-color', default=None,
                        help='Accent color as hex string for ovals, dividers, underlines '
                             '(default "#FF0000" red). E.g. "#CC0000" for dark red, "#003366" for navy.')
    parser.add_argument('--font-family', default=None,
                        choices=['serif', 'sans-serif'],
                        help='Font family for shirt PDF: "serif" (default, Times) or '
                             '"sans-serif" (Helvetica).')
    parser.add_argument('--sport', default=None,
                        help='Sport name in title line 1 (default "GYMNASTICS"). '
                             'E.g. "CHEERLEADING" or "DANCE".')
    parser.add_argument('--title-prefix', default=None,
                        help='Title line 2 prefix before state name (default "STATE CHAMPIONS OF"). '
                             'E.g. "REGIONAL CHAMPIONS OF" or "NATIONAL CHAMPIONS".')
    parser.add_argument('--header-size', type=float, default=None,
                        help='Font size for column headers (VAULT, BARS, etc.). Default 11.')
    parser.add_argument('--divider-size', type=float, default=None,
                        help='Font size for level divider text (LEVEL 10, SAPPHIRE, etc.). Default 10.')
    parser.add_argument('--regenerate', nargs='*', default=None,
                        help='Skip parsing/DB build and regenerate specific outputs from existing DB. '
                             'Values: shirt, idml, order_forms, gym_highlights, summary, all. '
                             'E.g. --regenerate shirt  or  --regenerate all')
    parser.add_argument('--page-size', default='letter',
                        choices=['letter', 'legal'],
                        help='Default page size for all page groups: "letter" or "legal".')
    parser.add_argument('--page-size-legal', nargs='*', default=None,
                        help='Page groups to generate at 8.5x14 IN ADDITION to 8.5x11. '
                             'E.g. --page-size-legal "XCEL" or --page-size-legal "LEVELS 3-10". '
                             'Matches against the oval label text on each page group. '
                             'Always generates 8.5x11 for all groups; this adds 8.5x14 '
                             'for the specified groups only.')
    parser.add_argument('--division-order', default=None,
                        help='Explicit division ordering, youngest to oldest, comma-separated. '
                             'E.g. "Petite,Cadet,Junior,Senior". Overrides auto-detection '
                             'for any divisions that match (case-insensitive).')
    parser.add_argument('--import-idml', default=None,
                        help='Import a finalized IDML file (edited in InDesign) and convert it to '
                             'the definitive back_of_shirt.pdf. Regenerates order forms and gym '
                             'highlights using the imported layout. The IDML must contain embedded '
                             'meet metadata (generated by this app).')
    parser.add_argument('--import-pdf', action='append', default=None,
                        help='Import designer-edited back PDF(s). Can be repeated for multiple pages. '
                             'System auto-detects letter (8.5x11) vs legal (8.5x14) from page dimensions. '
                             'For order forms, legal pages are scaled to letter unless a letter version exists.')
    parser.add_argument('--force', action='store_true',
                        help='Force overwrite of IDML-imported layouts during --regenerate. '
                             'Without this flag, --regenerate will refuse to overwrite a '
                             'back_of_shirt.pdf that was produced by --import-idml.')

    args = parser.parse_args()

    _has_pdf_import = bool(args.import_pdf)

    # --state and --meet are required unless --import-idml is used (has metadata fallback)
    if not args.import_idml:
        if not args.state:
            parser.error('--state is required')
        if not args.meet:
            parser.error('--meet is required')

    # --source and --data are required unless --regenerate, --import-idml, or --import-pdf is used
    if args.regenerate is None and not args.import_idml and not _has_pdf_import:
        if not args.source:
            parser.error('--source is required unless --regenerate or --import-idml is used')
        if not args.data:
            parser.error('--data is required unless --regenerate or --import-idml is used')

    # For --import-idml, pre-read embedded metadata to fill in missing state/meet/year
    if args.import_idml:
        try:
            with zipfile.ZipFile(args.import_idml, 'r') as zf:
                _meta = _peek_metadata(zf)
                if _meta:
                    if not args.state:
                        args.state = _meta.get('state', '')
                    if not args.meet:
                        args.meet = _meta.get('meet_name', '')
                    if args.year is None and _meta.get('year'):
                        args.year = _meta['year']
                    print(f"Read metadata from IDML: meet={_meta.get('meet_name')}, state={_meta.get('state')}, year={_meta.get('year')}")
                else:
                    print("No embedded metadata found in IDML -will convert to PDF only")
        except Exception as e:
            print(f"Warning: Could not read IDML metadata: {e}")
        # Default to placeholder values if metadata is missing
        if not args.state:
            args.state = 'Unknown'
        if not args.meet:
            args.meet = 'IDML Import'

    # Auto-detect year from meet name if not explicitly provided
    if args.year is None:
        m = re.search(r'\b(20\d{2})\b', args.meet or '')
        args.year = m.group(1) if m else str(datetime.datetime.now().year)

    # Build title lines
    title_lines = tuple(line for line in [args.title_line1, args.title_line2, args.title_line3] if line)

    config = MeetConfig(
        state=args.state,
        meet_name=args.meet,
        association=args.association,
        source_type=args.source,
        title_lines=title_lines,
        year=args.year,
    )

    os.makedirs(args.output, exist_ok=True)
    db_path = args.db if args.db else os.path.join(args.output, 'meet_results.db')
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)

    # Clean up deprecated output files from older versions
    for deprecated in ('order_forms_by_gym.txt', 'winners_sheet.csv'):
        dep_path = os.path.join(args.output, deprecated)
        if os.path.exists(dep_path):
            os.remove(dep_path)
            print(f"Cleaned up deprecated output: {deprecated}")

    # --import-pdf mode: import designer-edited PDF backs and regenerate dependents
    # Accepts N PDFs. Auto-detects letter (<=800pt) vs legal (>800pt) from page height.
    # For order forms: all pages are letter-size. Legal pages are scaled down UNLESS
    # a letter-size version is also provided (then the letter version is used as-is).
    if _has_pdf_import:
        import fitz
        _LETTER_W, _LETTER_H = 612.0, 792.0
        _LEGAL_THRESHOLD = 800  # pages taller than this are "legal"
        errors = []

        # Clean up any stale _NEW files from previous failed imports
        if os.path.exists(args.output):
            for f in os.listdir(args.output):
                if '_NEW.' in f:
                    try:
                        os.remove(os.path.join(args.output, f))
                        print(f"Cleaned up stale file: {f}")
                    except OSError:
                        pass

        # Step 0: Correct meet name case from DB (before creating any files)
        # The agent might pass "2026 NEVADA STATE CHAMPIONSHIPS" but the DB has
        # "2026 Nevada State Championships" — fix this before choosing output dir.
        if os.path.exists(db_path):
            try:
                _conn = sqlite3.connect(db_path)
                _row = _conn.execute(
                    'SELECT meet_name FROM winners WHERE LOWER(meet_name) = LOWER(?) LIMIT 1',
                    (config.meet_name,)
                ).fetchone()
                _conn.close()
                if _row and _row[0] != config.meet_name:
                    actual_name = _row[0]
                    print(f"Meet name case corrected: '{config.meet_name}' -> '{actual_name}'")
                    config.meet_name = actual_name
                    args.meet = actual_name
                    # Correct the output directory to match
                    _parent = os.path.dirname(args.output.rstrip('/\\'))
                    _corrected = os.path.join(_parent, actual_name)
                    if os.path.exists(_corrected):
                        args.output = _corrected
                        print(f"Output dir: {args.output}")
                    os.makedirs(args.output, exist_ok=True)
            except Exception:
                pass  # DB might not have winners table yet

        _main_shirt = os.path.join(args.output, 'back_of_shirt.pdf')
        _legal_shirt = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')

        # Step 1: Classify each imported PDF as letter or legal
        letter_pdfs = []  # paths to letter-size PDFs
        legal_pdfs = []   # paths to legal-size PDFs
        for pdf_path in args.import_pdf:
            if not os.path.exists(pdf_path):
                print(f"Error: PDF not found: {pdf_path}")
                sys.exit(1)
            doc = fitz.open(pdf_path)
            page_h = doc[0].rect.height if doc.page_count > 0 else 792
            doc.close()
            if page_h > _LEGAL_THRESHOLD:
                legal_pdfs.append(pdf_path)
                print(f"  Legal ({page_h:.0f}pt): {os.path.basename(pdf_path)}")
            else:
                letter_pdfs.append(pdf_path)
                print(f"  Letter ({page_h:.0f}pt): {os.path.basename(pdf_path)}")

        print(f"Importing {len(letter_pdfs)} letter + {len(legal_pdfs)} legal PDFs")

        # Step 2: Build back_of_shirt_8.5x14.pdf from all legal PDFs
        if legal_pdfs:
            legal_combined = fitz.open()
            try:
                for lp in legal_pdfs:
                    src = fitz.open(lp)
                    legal_combined.insert_pdf(src)
                    src.close()
                _tmp = _legal_shirt + '.tmp'
                legal_combined.save(_tmp)
                legal_combined.close()
                _safe_move(_tmp, _legal_shirt)
                print(f"Generated {_legal_shirt} ({fitz.open(_legal_shirt).page_count} pages)")
            except Exception as e:
                legal_combined.close()
                print(f"ERROR building legal PDF: {e}")
                errors.append(('legal_pdf', str(e)))

        # Step 3: Build back_of_shirt.pdf — ALL pages at LETTER SIZE (for order forms)
        # Mixed source: imported PDFs replace their size-matching pages.
        # Pages NOT replaced keep the existing code-generated version.
        # This enables e.g. custom 2-10 back + code-generated Xcel back in the same file.

        # Read existing back_of_shirt.pdf pages (if it exists from a prior build_database)
        _existing_pages = []  # list of (page_height, page_index) from existing file
        _existing_doc = None
        if os.path.exists(_main_shirt):
            try:
                _existing_doc = fitz.open(_main_shirt)
                for i in range(_existing_doc.page_count):
                    _existing_pages.append((_existing_doc[i].rect.height, i))
            except Exception:
                _existing_doc = None

        combined = fitz.open()
        try:
            # Legal pages: if the user provided a legal PDF but NO letter PDF,
            # use the EXISTING code-generated letter page (not a scaled rasterized version).
            # Scaling legal→letter produces a "smushed" look. The code-generated version
            # is already properly laid out for letter size.
            # Only rasterize/scale when there is NO existing code-generated page to use.
            _has_existing_letter_for_legal = False
            if legal_pdfs and not letter_pdfs and _existing_doc:
                # Check if existing back_of_shirt.pdf has code-generated pages we can reuse
                for h, idx in _existing_pages:
                    if h <= _LEGAL_THRESHOLD:
                        _has_existing_letter_for_legal = True
                        break

            if legal_pdfs and not _has_existing_letter_for_legal:
                for legal_path in legal_pdfs:
                    src = fitz.open(legal_path)
                    for i in range(src.page_count):
                        src_page = src[i]
                        scale_y = _LETTER_H / src_page.rect.height
                        new_pg = combined.new_page(width=_LETTER_W, height=_LETTER_H)
                        # Visual: rasterized image stretched to fill
                        pix = src_page.get_pixmap(dpi=300)
                        png_bytes = pix.tobytes("png")
                        del pix  # Free ~25MB pixmap immediately
                        new_pg.insert_image(fitz.Rect(0, 0, _LETTER_W, _LETTER_H), stream=png_bytes,
                                            keep_proportion=False)
                        # Searchable: invisible text layer with scaled positions
                        for block in src_page.get_text("dict")["blocks"]:
                            if block.get("type") != 0:
                                continue
                            for line in block["lines"]:
                                for span in line["spans"]:
                                    text = span["text"].strip()
                                    if not text:
                                        continue
                                    x = span["origin"][0]
                                    y = span["origin"][1] * scale_y
                                    fs = span["size"] * scale_y
                                    new_pg.insert_text(fitz.Point(x, y), text,
                                                       fontsize=max(fs, 1), render_mode=3)
                    src.close()
            # Then: add letter pages — imported if available, else keep existing
            if letter_pdfs:
                for lp in letter_pdfs:
                    src = fitz.open(lp)
                    combined.insert_pdf(src)
                    src.close()

            # If legal was provided but no letter, AND existing code-generated pages exist,
            # keep the code-generated letter pages (they look better than scaled rasterized)
            if _has_existing_letter_for_legal:
                for h, idx in _existing_pages:
                    if h <= _LEGAL_THRESHOLD:
                        combined.insert_pdf(_existing_doc, from_page=idx, to_page=idx)
                print("Kept existing code-generated letter pages for order forms (legal-only import)")
            elif not letter_pdfs and _existing_doc:
                # No letter PDFs imported and no existing code-generated — keep whatever is there
                for h, idx in _existing_pages:
                    if h <= _LEGAL_THRESHOLD:
                        combined.insert_pdf(_existing_doc, from_page=idx, to_page=idx)
                print("Kept existing letter-size pages (no letter PDFs imported)")

            # Similarly for legal: if no legal PDFs imported, keep existing scaled pages
            if not legal_pdfs and _existing_doc:
                for h, idx in _existing_pages:
                    if h > _LEGAL_THRESHOLD:
                        # This is a scaled-legal page from a previous import — keep it
                        combined.insert_pdf(_existing_doc, from_page=idx, to_page=idx, start_at=0)
                print("Kept existing scaled-legal pages (no legal PDFs imported)")

            _tmp = _main_shirt + '.tmp'
            combined.save(_tmp)
            _pc = combined.page_count
            combined.close()
            _safe_move(_tmp, _main_shirt)
            print(f"Generated {_main_shirt} ({_pc} pages, all letter size"
                  f"{', legal scaled' if legal_pdfs else ''})")
        except Exception as e:
            combined.close()
            print(f"ERROR building combined PDF: {e}")
            errors.append(('combine', str(e)))
        finally:
            if _existing_doc:
                _existing_doc.close()

        if not letter_pdfs and not legal_pdfs:
            print("Warning: No valid PDFs found in the provided paths.")

        # Step 3: Check for meet data in DB and regenerate dependents
        # (Meet name was already case-corrected in Step 0)
        has_meet_data = False
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path)
                count = conn.execute(
                    'SELECT COUNT(*) FROM winners WHERE meet_name = ?',
                    (config.meet_name,)
                ).fetchone()[0]
                conn.close()
                has_meet_data = count > 0
                if has_meet_data:
                    print(f"Found {count} winners for '{config.meet_name}' in database")
                else:
                    print(f"No winners found for '{config.meet_name}' in database")
            except Exception as e:
                print(f"Warning: Could not query database: {e}")

        if has_meet_data:
            # Load sticky layout params
            _layout_dir = os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(db_path))
            layout_json = os.path.join(_layout_dir, 'shirt_layout.json')
            saved_layout = {}
            if os.path.exists(layout_json):
                try:
                    with open(layout_json, 'r', encoding='utf-8') as f:
                        saved_layout = json.load(f)
                except (json.JSONDecodeError, OSError):
                    pass

            import_layout = LayoutParams.from_sticky_dict(saved_layout)
            _IMPORT_FIELDS = ['line_spacing', 'level_gap', 'max_fill',
                              'min_font_size', 'max_font_size', 'max_shirt_pages',
                              'title1_size', 'title2_size',
                              'copyright', 'accent_color',
                              'font_family', 'sport', 'title_prefix',
                              'header_size', 'divider_size']
            for param in _IMPORT_FIELDS:
                cli_val = getattr(args, param, None)
                if cli_val is not None:
                    setattr(import_layout, param, cli_val)
            import_layout.name_sort = args.name_sort

            # Restore level_groups, page_size_legal, division_order from sticky params
            if args.level_groups is None and 'level_groups' in saved_layout:
                args.level_groups = saved_layout['level_groups']
            if args.page_size_legal is None and 'page_size_legal' in saved_layout:
                args.page_size_legal = saved_layout['page_size_legal']
            if args.division_order is None and 'division_order' in saved_layout:
                args.division_order = saved_layout['division_order']

            # Restore saved dates if not provided on CLI
            if args.postmark_date == 'TBD' and 'postmark_date' in saved_layout:
                args.postmark_date = saved_layout['postmark_date']
            if args.online_date == 'TBD' and 'online_date' in saved_layout:
                args.online_date = saved_layout['online_date']
            if args.ship_date == 'TBD' and 'ship_date' in saved_layout:
                args.ship_date = saved_layout['ship_date']

            # Determine legal/letter level split for gym highlights
            _legal_groups = args.page_size_legal or []
            _has_legal = any(_legal_groups)
            _import_legal_levels = None
            _import_letter_levels = None

            if _has_legal:
                _imp_div_list = _parse_division_order(args.division_order)
                _gh_pre = precompute_shirt_data(db_path, config.meet_name,
                                                layout=import_layout,
                                                level_groups=args.level_groups,
                                                exclude_levels=args.exclude_levels,
                                                division_order=_imp_div_list)
                _legal_lvs = []
                _letter_lvs = []
                for _lbl, _lvs in _gh_pre['page_groups']:
                    _filt_upper = {f.upper() for f in _legal_groups}
                    _label_match = any(f.upper() in _lbl.upper() for f in _legal_groups)
                    _level_match = bool({lv.upper() for lv in _lvs} & _filt_upper)
                    if _label_match or _level_match:
                        _legal_lvs.extend(_lvs)
                    else:
                        _letter_lvs.extend(_lvs)
                _import_legal_levels = _legal_lvs if _legal_lvs else None
                _import_letter_levels = _letter_lvs if _letter_lvs else None

            # Gym highlights — use the IMPORTED PDFs as visual base (overlay mode)
            # This preserves the designer's fonts, colors, spacing, and layout.
            # IMPORTANT: Use the ORIGINAL imported PDFs, not the combined back_of_shirt.pdf
            # (which has scaled legal pages mixed in for order form purposes).

            # Build a letter-only PDF from the original letter imports (for gym highlights)
            _letter_only_shirt = None
            if letter_pdfs:
                _letter_only_shirt = os.path.join(args.output, '_gh_letter_tmp.pdf')
                _lo_doc = fitz.open()
                for lp in letter_pdfs:
                    _s = fitz.open(lp)
                    _lo_doc.insert_pdf(_s)
                    _s.close()
                _lo_doc.save(_letter_only_shirt)
                _lo_doc.close()

            if legal_pdfs and letter_pdfs:
                # Both sizes: letter gym_highlights uses letter back, legal uses legal back
                # Letter highlights exclude names that appear on the legal back
                try:
                    gh_path = os.path.join(args.output, 'gym_highlights.pdf')
                    tmp = _tmp_path_for(gh_path)
                    generate_gym_highlights_from_pdf(
                        _letter_only_shirt, db_path, config.meet_name, tmp,
                        exclude_shirt_path=_legal_shirt,
                        font_family=import_layout.font_family,
                        accent_color=import_layout.accent_color)
                    actual = _safe_move(tmp, gh_path)
                    print(f"Generated {actual} (from imported letter PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights.pdf: {e}")
                    errors.append(('gym_highlights', str(e)))
                try:
                    gh_legal = os.path.join(args.output, 'gym_highlights_8.5x14.pdf')
                    tmp = _tmp_path_for(gh_legal)
                    # Exclude names from the LETTER-ONLY PDF, not the combined
                    # (combined has all names including legal, which would exclude everything)
                    generate_gym_highlights_from_pdf(
                        _legal_shirt, db_path, config.meet_name, tmp,
                        exclude_shirt_path=_letter_only_shirt,
                        font_family=import_layout.font_family,
                        accent_color=import_layout.accent_color)
                    actual = _safe_move(tmp, gh_legal)
                    print(f"Generated {actual} (from imported legal PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights_8.5x14.pdf: {e}")
                    errors.append(('gym_highlights_legal', str(e)))
            elif legal_pdfs:
                # Only legal imported
                try:
                    gh_legal = os.path.join(args.output, 'gym_highlights_8.5x14.pdf')
                    tmp = _tmp_path_for(gh_legal)
                    generate_gym_highlights_from_pdf(
                        _legal_shirt, db_path, config.meet_name, tmp,
                        font_family=import_layout.font_family,
                        accent_color=import_layout.accent_color)
                    actual = _safe_move(tmp, gh_legal)
                    print(f"Generated {actual} (from imported legal PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights_8.5x14.pdf: {e}")
                    errors.append(('gym_highlights_legal', str(e)))
            elif letter_pdfs:
                # Only letter imported
                try:
                    gh_path = os.path.join(args.output, 'gym_highlights.pdf')
                    tmp = _tmp_path_for(gh_path)
                    generate_gym_highlights_from_pdf(
                        _letter_only_shirt, db_path, config.meet_name, tmp,
                        font_family=import_layout.font_family,
                        accent_color=import_layout.accent_color)
                    actual = _safe_move(tmp, gh_path)
                    print(f"Generated {actual} (from imported letter PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights.pdf: {e}")
                    errors.append(('gym_highlights', str(e)))

            # Clean up temp letter-only PDF
            if _letter_only_shirt and os.path.exists(_letter_only_shirt):
                os.remove(_letter_only_shirt)

            # Order forms — use back_of_shirt.pdf which has ALL pages
            try:
                order_path = os.path.join(args.output, 'order_forms.pdf')
                tmp = _tmp_path_for(order_path)
                _imp_of_div_list = _parse_division_order(args.division_order)
                generate_order_forms_pdf(db_path, config.meet_name, tmp,
                                         year=args.year, state=args.state,
                                         state_abbrev=args.state_abbrev,
                                         postmark_date=args.postmark_date,
                                         online_date=args.online_date,
                                         ship_date=args.ship_date,
                                         layout=import_layout,
                                         name_sort=import_layout.name_sort,
                                         level_groups=args.level_groups,
                                         exclude_levels=args.exclude_levels,
                                         shirt_pdf_path=_main_shirt,
                                         division_order=_imp_of_div_list)
                actual = _safe_move(tmp, order_path)
                print(f"Generated {actual}")
            except Exception as e:
                print(f"ERROR generating order_forms.pdf: {e}")
                errors.append(('order_forms', str(e)))

            # Meet summary
            try:
                summary_path = os.path.join(args.output, 'meet_summary.txt')
                generate_meet_summary(db_path, config.meet_name, summary_path,
                                      layout=import_layout,
                                      level_groups=args.level_groups,
                                      exclude_levels=args.exclude_levels)
                print(f"Generated {summary_path}")
            except Exception as e:
                print(f"ERROR generating meet_summary.txt: {e}")
                errors.append(('summary', str(e)))

            # Mark layout as imported and persist dates
            saved_layout['_source'] = 'imported'
            saved_layout['_import_date'] = datetime.datetime.now().isoformat()
            if args.postmark_date and args.postmark_date != 'TBD':
                saved_layout['postmark_date'] = args.postmark_date
            if args.online_date and args.online_date != 'TBD':
                saved_layout['online_date'] = args.online_date
            if args.ship_date and args.ship_date != 'TBD':
                saved_layout['ship_date'] = args.ship_date
            try:
                with open(layout_json, 'w', encoding='utf-8') as f:
                    json.dump(saved_layout, f, indent=2)
            except Exception:
                pass
        else:
            print(f"Note: No data for '{config.meet_name}' in database. "
                  f"Only the back PDFs were copied (no order forms or gym highlights).")

        if errors:
            print(f"\nDone with {len(errors)} error(s):")
            for name, msg in errors:
                print(f"  - {name}: {msg}")
            sys.exit(1)
        else:
            print("\nDone!")
            sys.exit(0)

    # --import-idml mode: DEPRECATED — use --import-pdf instead
    if args.import_idml:
        print("Error: --import-idml is deprecated. Use --import-pdf instead.")
        print("Export your edited backs as PDF from InDesign, then use import_pdf_backs.")
        sys.exit(1)
        # Dead code removed — the old --import-idml body (~300 lines) was deleted.
        # The --import-pdf code path handles all PDF back import functionality.

    # --regenerate mode: skip parsing/DB build, just regenerate specified outputs
    regen = args.regenerate
    if regen is not None:
        # --regenerate with no values means 'all'
        if len(regen) == 0:
            regen = ['all']
        # Support comma-separated values: --regenerate order_forms,gym_highlights
        expanded = []
        for item in regen:
            expanded.extend(item.split(','))
        regen_set = set(expanded)
        do_all = 'all' in regen_set

        if not os.path.exists(db_path):
            print(f"Error: Database not found at {db_path}. Run full pipeline first.")
            sys.exit(1)

        # Load saved_layout early so shirt cascade check can reference it
        _layout_dir = os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(db_path))
        _regen_layout_json = os.path.join(_layout_dir, 'shirt_layout.json')
        saved_layout = {}
        if os.path.exists(_regen_layout_json):
            try:
                with open(_regen_layout_json, 'r', encoding='utf-8') as f:
                    saved_layout = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass

        # When shirt regenerates, cascade to outputs that depend on the shirt PDF:
        # - order_forms embeds actual shirt PDF pages
        # - summary reads layout data (page groups, athlete counts)
        # - gym_highlights uses shirt PDF as base in code-generated mode (not imported)
        # idml is independent (re-derives layout from DB) — don't cascade.
        if 'shirt' in regen_set:
            regen_set.update(['order_forms', 'summary'])
            if saved_layout.get('_source') != 'imported':
                regen_set.add('gym_highlights')

        print(f"Regenerating outputs from existing database: {', '.join(regen_set)}")
    else:
        regen_set = set()
        do_all = False  # Full pipeline builds DB only — outputs generated via regenerate_output

        # Reset sticky params for new meets — prevents leaking from previous meets
        # (e.g., Nevada's level_groups and page_size_legal applied to Mississippi)
        _layout_dir = os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(db_path))
        _layout_json = os.path.join(_layout_dir, 'shirt_layout.json')
        if os.path.exists(_layout_json):
            os.remove(_layout_json)
            print("Reset sticky params (shirt_layout.json) for new meet")

        # Select adapter
        if args.source == 'scorecat':
            adapter = ScoreCatAdapter()
        elif args.source in ('generic', 'mso_pdf', 'mso_html'):
            # mso_pdf and mso_html are legacy — treat as generic for backwards compatibility
            adapter = GenericAdapter()
        else:
            print(f"Unknown source type: {args.source}")
            sys.exit(1)

        # Parse data (supports multiple files via nargs='+')
        if len(args.data) == 1:
            print(f"Parsing {args.data[0]}...")
            athletes = adapter.parse(args.data[0])
            print(f"Parsed {len(athletes)} athletes")
        else:
            all_athletes = []
            for data_path in args.data:
                print(f"Parsing {data_path}...")
                batch = adapter.parse(data_path)
                print(f"  -> {len(batch)} athletes")
                all_athletes.extend(batch)
            athletes = all_athletes
            print(f"Total: {len(athletes)} athletes from {len(args.data)} files")

        # Load persistent gym aliases from Supabase (best-effort)
        aliases: dict[str, str] | None = None
        try:
            import urllib.request
            _sb_url = os.environ.get('SUPABASE_URL', '')
            _sb_key = os.environ.get('SUPABASE_KEY', '')
            if _sb_url and _sb_key:
                from python.core.constants import state_to_abbrev
                _state_abbrev = state_to_abbrev(args.state)
                _req = urllib.request.Request(
                    f"{_sb_url.rstrip('/')}/rest/v1/rpc/get_gym_aliases",
                    data=json.dumps({"p_state": _state_abbrev}).encode('utf-8'),
                    headers={
                        'apikey': _sb_key,
                        'Authorization': f'Bearer {_sb_key}',
                        'Content-Type': 'application/json',
                    },
                    method='POST',
                )
                with urllib.request.urlopen(_req, timeout=5) as _resp:
                    _rows = json.loads(_resp.read().decode('utf-8'))
                if _rows and isinstance(_rows, list):
                    aliases = {r['alias']: r['canonical'] for r in _rows
                               if 'alias' in r and 'canonical' in r}
                    print(f"Loaded {len(aliases)} gym aliases from Supabase")
        except Exception as e:
            print(f"Warning: Could not load gym aliases from Supabase: {e}")

        # Normalize gym names
        result = normalize_gyms(athletes, gym_map_path=args.gym_map, aliases=aliases)
        athletes = result['normalized_athletes']
        print_gym_report(result['gym_report'])

        # Build database
        print(f"Building database at {db_path}...")
        build_database(db_path, config, athletes)

    # Division ordering — agent provides explicit order via --division-order
    _explicit = None
    if args.division_order:
        _explicit = _parse_division_order(args.division_order)
    division_order, div_warnings = detect_division_order(
        db_path, config.meet_name, explicit_order=_explicit)
    print(f"Division order ({len(division_order)} divisions): {list(division_order.keys())}")
    for w in div_warnings:
        print(w)

    # Check for gaps in division letter sequences (e.g. Ch A,B,C + Jr D → Jr A,B,C missing)
    gap_warnings = detect_division_gaps(list(division_order.keys()))
    for w in gap_warnings:
        print(w)
    if gap_warnings:
        print("These gaps may indicate missing data from a separate meet/session. "
              "Verify all sessions were extracted before generating final outputs.")

    # Also cache for get_division_order consumers
    config_dir = os.path.dirname(os.path.abspath(db_path))

    # --- Sticky shirt layout params ---
    # After a user adjusts layout (e.g. --max-shirt-pages 2), those params
    # persist in shirt_layout.json so future runs use the same layout.
    # CLI args override saved params; saved params override defaults.
    # Stored in app data dir (not user-visible output folder).
    _layout_dir = os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(db_path))
    layout_json = os.path.join(_layout_dir, 'shirt_layout.json')
    saved_layout = {}
    if os.path.exists(layout_json):
        try:
            with open(layout_json, 'r') as f:
                saved_layout = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    # Load saved sticky params, then override with any CLI-provided values
    layout = LayoutParams.from_sticky_dict(saved_layout)
    # CLI overrides (only if explicitly set, i.e. not None)
    _LAYOUT_FIELD_NAMES = [
        'line_spacing', 'level_gap', 'max_fill',
        'min_font_size', 'max_font_size', 'max_shirt_pages',
        'title1_size', 'title2_size',
        'copyright', 'accent_color', 'font_family',
        'sport', 'title_prefix', 'header_size', 'divider_size',
    ]
    for param in _LAYOUT_FIELD_NAMES:
        cli_val = getattr(args, param, None)
        if cli_val is not None:
            setattr(layout, param, cli_val)
    layout.name_sort = args.name_sort

    # --- Sticky structural params (level_groups, page_size_legal) ---
    # These are structural choices (e.g. "2 pages: Xcel + Levels 2-10") that
    # should persist across regenerations. Unlike exclude_levels (a destructive
    # filter that can silently drop athletes), these only control grouping and
    # page size assignment — no data is lost. CLI values override saved values.
    if args.level_groups is None and 'level_groups' in saved_layout:
        args.level_groups = saved_layout['level_groups']
    if args.page_size_legal is None and 'page_size_legal' in saved_layout:
        args.page_size_legal = saved_layout['page_size_legal']
    if args.division_order is None and 'division_order' in saved_layout:
        args.division_order = saved_layout['division_order']

    # Restore saved dates if not provided on CLI
    if args.postmark_date == 'TBD' and 'postmark_date' in saved_layout:
        args.postmark_date = saved_layout['postmark_date']
        print(f"Restored saved postmark date: {args.postmark_date}")
    if args.online_date == 'TBD' and 'online_date' in saved_layout:
        args.online_date = saved_layout['online_date']
        print(f"Restored saved online date: {args.online_date}")
    if args.ship_date == 'TBD' and 'ship_date' in saved_layout:
        args.ship_date = saved_layout['ship_date']
        print(f"Restored saved ship date: {args.ship_date}")

    # Require division_order for shirt/all outputs — alphabetical fallback is always wrong
    if (do_all or 'shirt' in regen_set) and not args.division_order:
        print("DIVISION_ORDER_REQUIRED: Cannot generate shirt outputs without division_order. "
              "Query the divisions with: SELECT DISTINCT level, division FROM results WHERE meet_name = '...' ORDER BY level, division "
              "Then call regenerate_output with division_order set to a comma-separated list ordered youngest to oldest.")
        sys.exit(1)

    # Generate outputs (all or selected)
    # Each output is wrapped in try/except so one failure doesn't block the rest
    errors = []

    # order_txt and csv are only generated on explicit --regenerate request (not in full pipeline)
    if 'order_txt' in regen_set:
        try:
            orders_path = os.path.join(args.output, 'order_forms_by_gym.txt')
            generate_order_forms(db_path, config.meet_name, orders_path)
            print(f"Generated {orders_path}")
        except Exception as e:
            print(f"ERROR generating order_forms_by_gym.txt: {e}")
            errors.append(('order_txt', str(e)))

    # Determine which page groups need legal-size output
    _legal_groups = args.page_size_legal
    if args.page_size == 'legal' and not _legal_groups:
        _legal_groups = ['']  # empty string matches all groups

    # Pre-compute shirt data ONCE and reuse across all generators
    pre = None
    if do_all or 'shirt' in regen_set:
        _div_list = _parse_division_order(args.division_order)
        pre = precompute_shirt_data(db_path, config.meet_name,
                                    layout=layout,
                                    level_groups=args.level_groups,
                                    exclude_levels=args.exclude_levels,
                                    division_order=_div_list)

        _flagged = pre.get('flagged_names', [])
        _modified = pre.get('modified_names', [])
        if _modified:
            print(f"NAME_CLEANUP: {len(_modified)} name(s) were auto-cleaned:")
            for raw, cleaned, event, level in _modified[:20]:
                print(f"  L{level} {event}: \"{raw}\" -> \"{cleaned}\"")
            if len(_modified) > 20:
                print(f"  ... and {len(_modified) - 20} more")
        if _flagged:
            print(f"SUSPICIOUS_NAMES: {len(_flagged)} name(s) look unusual and may need manual review:")
            for cleaned, raw, event, level, reason in _flagged:
                print(f"  L{level} {event}: \"{cleaned}\" -{reason}")
            print("If any of these need fixing, you can update the names in the database "
                  "with query_db or re-run the data extraction.")
            # Machine-readable JSON for TypeScript to parse and gate subsequent regenerations.
            # "raw" = name as stored in DB (for UPDATE WHERE clause).
            # "cleaned" = name after re-running clean_athlete_name (uses the canonical regex).
            import json as _json
            from python.core.db_builder import clean_athlete_name as _clean
            _suspicious_items = []
            _seen_names = set()
            for cleaned_name, raw_name, event, level, reason in _flagged:
                if 'event code' in reason.lower() or 'event keyword' in reason.lower():
                    _stripped = _clean(raw_name)
                    if raw_name not in _seen_names:
                        _seen_names.add(raw_name)
                        _suspicious_items.append({"raw": raw_name, "cleaned": _stripped or raw_name})
            if _suspicious_items:
                print(f"SUSPICIOUS_NAMES_JSON: {_json.dumps(_suspicious_items)}")

    # Guard against --regenerate destroying designer-edited IDML imports
    if (do_all or 'shirt' in regen_set) and args.regenerate is not None:
        if saved_layout.get('_source') == 'imported' and not args.force:
            print('WARNING: back_of_shirt.pdf was produced by IDML import.')
            print(f'  Imported from: {saved_layout.get("_import_path", "unknown")}')
            print(f'  Import date:   {saved_layout.get("_import_date", "unknown")}')
            print('Running --regenerate will destroy designer edits.')
            print('Use --force to override.')
            sys.exit(1)

    if do_all or 'shirt' in regen_set:
        try:
            pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
            tmp = _tmp_path_for(pdf_path)
            generate_shirt_pdf(db_path, config.meet_name, tmp,
                               year=args.year, state=args.state,
                               layout=layout,
                               level_groups=args.level_groups,
                               exclude_levels=args.exclude_levels,
                               precomputed=pre)
            actual = _safe_move(tmp, pdf_path)
            print(f"Generated {actual}")
            # Save effective layout params so future runs reuse them
            # Note: to_sticky_dict() excludes sentinel keys (_source, _import_path,
            # _import_date), so --regenerate --force automatically clears the sentinel
            _sticky = layout.to_sticky_dict()
            # Also persist structural params (level_groups, page_size_legal) so
            # regenerations preserve the user's page grouping and legal-size choices
            if args.level_groups is not None:
                _sticky['level_groups'] = args.level_groups
            if args.page_size_legal is not None:
                _sticky['page_size_legal'] = args.page_size_legal
            # division_order reorders presentation (youngest→oldest) but does
            # NOT exclude athletes, so it's safe to persist across regenerations
            if args.division_order is not None:
                _sticky['division_order'] = args.division_order
            # Persist dates so they survive across regenerations
            if args.postmark_date and args.postmark_date != 'TBD':
                _sticky['postmark_date'] = args.postmark_date
            if args.online_date and args.online_date != 'TBD':
                _sticky['online_date'] = args.online_date
            if args.ship_date and args.ship_date != 'TBD':
                _sticky['ship_date'] = args.ship_date
            with open(layout_json, 'w') as f:
                json.dump(_sticky, f, indent=2)
        except Exception as e:
            print(f"ERROR generating back_of_shirt.pdf: {e}")
            errors.append(('shirt', str(e)))

        # Generate 8.5x14 versions for specified page groups
        if _legal_groups:
            _filter = _legal_groups if any(_legal_groups) else None
            try:
                legal_pdf = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')
                tmp = _tmp_path_for(legal_pdf)
                generate_shirt_pdf(db_path, config.meet_name, tmp,
                                   year=args.year, state=args.state,
                                   layout=layout,
                                   level_groups=args.level_groups,
                                   exclude_levels=args.exclude_levels,
                                   page_h=PAGE_H_LEGAL,
                                   page_group_filter=_filter)
                actual = _safe_move(tmp, legal_pdf)
                print(f"Generated {actual} (8.5x14)")
            except Exception as e:
                print(f"ERROR generating back_of_shirt_8.5x14.pdf: {e}")
                errors.append(('shirt_legal', str(e)))

    if do_all or 'idml' in regen_set:
        try:
            idml_path = os.path.join(args.output, 'back_of_shirt.idml')
            generate_shirt_idml(db_path, config.meet_name, idml_path,
                                year=args.year, state=args.state,
                                layout=layout,
                                level_groups=args.level_groups,
                                exclude_levels=args.exclude_levels,
                                precomputed=pre)
            print(f"Generated {idml_path}")
        except Exception as e:
            print(f"ERROR generating back_of_shirt.idml: {e}")
            errors.append(('idml', str(e)))

        # Generate 8.5x14 IDML for specified page groups
        if _legal_groups:
            _filter = _legal_groups if any(_legal_groups) else None
            try:
                legal_idml = os.path.join(args.output, 'back_of_shirt_8.5x14.idml')
                generate_shirt_idml(db_path, config.meet_name, legal_idml,
                                    year=args.year, state=args.state,
                                    layout=layout,
                                    level_groups=args.level_groups,
                                    exclude_levels=args.exclude_levels,
                                    page_h=PAGE_H_LEGAL,
                                    page_group_filter=_filter)
                print(f"Generated {legal_idml} (8.5x14)")
            except Exception as e:
                print(f"ERROR generating back_of_shirt_8.5x14.idml: {e}")
                errors.append(('idml_legal', str(e)))

    if do_all or 'order_forms' in regen_set:
        try:
            order_pdf_path = os.path.join(args.output, 'order_forms.pdf')
            # Use existing back_of_shirt.pdf for back pages so IDML edits are preserved
            existing_shirt_pdf = os.path.join(args.output, 'back_of_shirt.pdf')
            _shirt_path = existing_shirt_pdf if os.path.exists(existing_shirt_pdf) else None
            tmp = _tmp_path_for(order_pdf_path)
            _of_div_list = _parse_division_order(args.division_order)
            generate_order_forms_pdf(db_path, config.meet_name, tmp,
                                     year=args.year, state=args.state,
                                     state_abbrev=args.state_abbrev,
                                     postmark_date=args.postmark_date,
                                     online_date=args.online_date,
                                     ship_date=args.ship_date,
                                     layout=layout,
                                     level_groups=args.level_groups,
                                     exclude_levels=args.exclude_levels,
                                     shirt_pdf_path=_shirt_path,
                                     precomputed=pre,
                                     division_order=_of_div_list)
            actual = _safe_move(tmp, order_pdf_path)
            print(f"Generated {actual}")
        except Exception as e:
            print(f"ERROR generating order_forms.pdf: {e}")
            errors.append(('order_forms', str(e)))

    if do_all or 'gym_highlights' in regen_set:
        letter_shirt = os.path.join(args.output, 'back_of_shirt.pdf')
        legal_shirt = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')
        _has_legal = _legal_groups and os.path.exists(legal_shirt)
        _is_imported = saved_layout.get('_source') == 'imported'

        if _is_imported and os.path.exists(letter_shirt):
            # IMPORTED MODE: overlay gym highlights on the actual imported PDFs
            # This preserves the designer's fonts, colors, spacing, and layout.
            print("Gym highlights: using imported PDF overlay mode")
            if _has_legal and os.path.exists(legal_shirt):
                # Both letter and legal backs exist — generate both with exclusion
                try:
                    gh_path = os.path.join(args.output, 'gym_highlights.pdf')
                    tmp = _tmp_path_for(gh_path)
                    generate_gym_highlights_from_pdf(
                        letter_shirt, db_path, config.meet_name, tmp,
                        exclude_shirt_path=legal_shirt,
                        font_family=layout.font_family,
                        accent_color=layout.accent_color)
                    actual = _safe_move(tmp, gh_path)
                    print(f"Generated {actual} (from imported letter PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights.pdf: {e}")
                    errors.append(('gym_highlights', str(e)))
                try:
                    gh_legal_path = os.path.join(args.output, 'gym_highlights_8.5x14.pdf')
                    tmp = _tmp_path_for(gh_legal_path)
                    generate_gym_highlights_from_pdf(
                        legal_shirt, db_path, config.meet_name, tmp,
                        exclude_shirt_path=letter_shirt,
                        font_family=layout.font_family,
                        accent_color=layout.accent_color)
                    actual = _safe_move(tmp, gh_legal_path)
                    print(f"Generated {actual} (from imported legal PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights_8.5x14.pdf: {e}")
                    errors.append(('gym_highlights_legal', str(e)))
            else:
                # Only letter back — generate single gym highlights
                try:
                    gh_path = os.path.join(args.output, 'gym_highlights.pdf')
                    tmp = _tmp_path_for(gh_path)
                    generate_gym_highlights_from_pdf(
                        letter_shirt, db_path, config.meet_name, tmp,
                        font_family=layout.font_family,
                        accent_color=layout.accent_color)
                    actual = _safe_move(tmp, gh_path)
                    print(f"Generated {actual} (from imported letter PDF)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights.pdf: {e}")
                    errors.append(('gym_highlights', str(e)))
        else:
            # CODE-GENERATED MODE: standard gym highlights from database
            _legal_levels = None
            _letter_levels = None
            if _has_legal:
                _gh_div_list = _parse_division_order(args.division_order)
                _gh_pre = pre if pre is not None else precompute_shirt_data(
                    db_path, config.meet_name, layout=layout,
                    level_groups=args.level_groups,
                    exclude_levels=args.exclude_levels,
                    division_order=_gh_div_list)
                _legal_filter = _legal_groups if any(_legal_groups) else None
                _legal_lvs = []
                _letter_lvs = []
                for _lbl, _lvs in _gh_pre['page_groups']:
                    if _legal_filter is not None:
                        _filt_upper = {f.upper() for f in _legal_filter}
                        _label_match = any(f.upper() in _lbl.upper() for f in _legal_filter)
                        _level_match = bool({lv.upper() for lv in _lvs} & _filt_upper)
                        if _label_match or _level_match:
                            _legal_lvs.extend(_lvs)
                        else:
                            _letter_lvs.extend(_lvs)
                    else:
                        _letter_lvs.extend(_lvs)
                _legal_levels = _legal_lvs if _legal_lvs else None
                _letter_levels = _letter_lvs if _letter_lvs else None

            if _has_legal:
                try:
                    gh_legal_path = os.path.join(args.output, 'gym_highlights_8.5x14.pdf')
                    tmp = _tmp_path_for(gh_legal_path)
                    generate_gym_highlights_pdf(db_path, config.meet_name, tmp,
                                                year=args.year, state=args.state,
                                                layout=layout,
                                                level_groups=args.level_groups,
                                                exclude_levels=args.exclude_levels,
                                                page_h=PAGE_H_LEGAL,
                                                include_levels=_legal_levels)
                    actual = _safe_move(tmp, gh_legal_path)
                    print(f"Generated {actual} (8.5x14)")
                except Exception as e:
                    print(f"ERROR generating gym_highlights_8.5x14.pdf: {e}")
                    errors.append(('gym_highlights_legal', str(e)))

            try:
                gym_highlights_path = os.path.join(args.output, 'gym_highlights.pdf')
                tmp = _tmp_path_for(gym_highlights_path)
                generate_gym_highlights_pdf(db_path, config.meet_name, tmp,
                                            year=args.year, state=args.state,
                                            layout=layout,
                                            level_groups=args.level_groups,
                                            exclude_levels=args.exclude_levels,
                                            precomputed=pre,
                                            include_levels=_letter_levels)
                actual = _safe_move(tmp, gym_highlights_path)
                print(f"Generated {actual}")
            except Exception as e:
                print(f"ERROR generating gym_highlights.pdf: {e}")
                errors.append(('gym_highlights', str(e)))

    if do_all or 'summary' in regen_set:
        try:
            summary_path = os.path.join(args.output, 'meet_summary.txt')
            generate_meet_summary(db_path, config.meet_name, summary_path,
                                  layout=layout,
                                  level_groups=args.level_groups,
                                  exclude_levels=args.exclude_levels,
                                  precomputed=pre)
            print(f"Generated {summary_path}")
        except Exception as e:
            print(f"ERROR generating meet_summary.txt: {e}")
            errors.append(('summary', str(e)))

    # Clean up any leftover temp files in the output directory
    for tmp_file in glob.glob(os.path.join(args.output, 'tmp*.pdf')):
        try:
            os.remove(tmp_file)
        except OSError:
            pass

    if errors:
        print(f"\nDone with {len(errors)} error(s):")
        for name, msg in errors:
            print(f"  - {name}: {msg}")
        sys.exit(1)
    else:
        print("\nDone!")


if __name__ == '__main__':
    main()
