#!/usr/bin/env python3
"""CLI entry point for processing a gymnastics meet.

Usage:
    python process_meet.py --source scorecat --data ia_athletes.json \\
        --state Iowa --meet "2025 Iowa Dev State Championships" \\
        --association USAG --output ./output/
"""

import argparse
import datetime
import json
import os
import re
import shutil
import sys
import tempfile

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
    if _page_num < 1 or _page_num > len(_doc):
        print(f"Error: Page {_page_num} out of range (PDF has {len(_doc)} pages)")
        sys.exit(1)
    _page = _doc[_page_num - 1]
    _pix = _page.get_pixmap(dpi=200)
    _png_bytes = _pix.tobytes("png")
    print(base64.b64encode(_png_bytes).decode('ascii'))
    _doc.close()
    sys.exit(0)

# Add parent directory to path for imports (skip when frozen by PyInstaller)
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python.core.models import MeetConfig
from python.core.db_builder import build_database
from python.core.output_generator import (
    generate_order_forms, generate_winners_csv  # kept for --regenerate backward compat
)
from python.core.pdf_generator import (
    generate_shirt_pdf, generate_gym_highlights_pdf,
    generate_gym_highlights_from_pdf
)
from python.core.icml_generator import generate_shirt_icml
from python.core.idml_generator import generate_shirt_idml
from python.core.idml_parser import idml_to_pdf
from python.core.meet_summary import generate_meet_summary
from python.core.order_form_generator import generate_order_forms_pdf
from python.core.gym_normalizer import normalize as normalize_gyms, print_gym_report
from python.adapters.scorecat_adapter import ScoreCatAdapter
from python.adapters.html_adapter import HtmlAdapter
from python.adapters.pdf_adapter import PdfAdapter
from python.adapters.generic_adapter import GenericAdapter
from python.core.division_detector import get_division_order


def _tmp_path_for(output_path):
    """Create a temp file path in the same directory as output_path."""
    dir_name = os.path.dirname(output_path) or '.'
    _, ext = os.path.splitext(output_path)
    fd, tmp = tempfile.mkstemp(suffix=ext, dir=dir_name)
    os.close(fd)
    return tmp


def _safe_move(tmp_path, final_path):
    """Move tmp_path → final_path, handling Windows file-locking gracefully.

    If the target is locked (open in a PDF viewer), saves as <name>_NEW.<ext>
    so the user's work is never lost. Returns the actual path used.
    """
    try:
        os.replace(tmp_path, final_path)
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

    args = parser.parse_args()

    # --state and --meet are required unless --import-idml is used (metadata fallback)
    if not args.import_idml:
        if not args.state:
            parser.error('--state is required unless --import-idml is used')
        if not args.meet:
            parser.error('--meet is required unless --import-idml is used')

    # --source and --data are required unless --regenerate or --import-idml is used
    if args.regenerate is None and not args.import_idml:
        if not args.source:
            parser.error('--source is required unless --regenerate or --import-idml is used')
        if not args.data:
            parser.error('--data is required unless --regenerate or --import-idml is used')

    # For --import-idml, pre-read embedded metadata to fill in missing state/meet/year
    if args.import_idml:
        from python.core.idml_parser import _load_metadata as _peek_metadata
        import zipfile as _zf
        try:
            with _zf.ZipFile(args.import_idml, 'r') as zf:
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
    title_lines = tuple(l for l in [args.title_line1, args.title_line2, args.title_line3] if l)

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

    # --import-idml mode: convert finalized IDML to PDF and regenerate dependents
    if args.import_idml:
        if not os.path.exists(args.import_idml):
            print(f"Error: IDML file not found: {args.import_idml}")
            sys.exit(1)

        print(f"Importing IDML: {args.import_idml}")
        # Generate to temp first, then detect page size
        _tmp_import = os.path.join(args.output, '_import_tmp.pdf')
        metadata = idml_to_pdf(args.import_idml, _tmp_import)
        imported_page_h = metadata.get('page_h', 792)
        is_legal_import = imported_page_h > 800  # 1008 for legal vs 792 for letter

        if is_legal_import:
            # Legal-size IDML → save as back_of_shirt_8.5x14.pdf
            pdf_path = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')
            os.replace(_tmp_import, pdf_path)
            print(f"Generated {pdf_path} (8.5x14 legal)")
        else:
            # Standard letter-size IDML → save as back_of_shirt.pdf
            pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
            os.replace(_tmp_import, pdf_path)
            print(f"Generated {pdf_path}")

        # Regenerate order forms and gym highlights using the existing DB
        # Verify the meet actually has data in the DB
        has_meet_data = False
        if os.path.exists(db_path):
            try:
                import sqlite3
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
            # Load sticky layout params (stored in data dir, not output folder)
            _layout_dir = os.environ.get('DATA_DIR') or os.path.dirname(os.path.abspath(db_path))
            layout_json = os.path.join(_layout_dir, 'shirt_layout.json')
            saved_layout = {}
            if os.path.exists(layout_json):
                try:
                    with open(layout_json, 'r') as f:
                        saved_layout = json.load(f)
                except (json.JSONDecodeError, OSError):
                    pass
            # NOTE: level_groups, exclude_levels, page_size NOT included here
            # (same as LAYOUT_PARAMS — they are per-run overrides, not sticky)
            LAYOUT_PARAMS_IMPORT = ['line_spacing', 'level_gap', 'max_fill',
                                    'min_font_size', 'max_font_size', 'max_shirt_pages',
                                    'title1_size', 'title2_size',
                                    'copyright', 'accent_color',
                                    'font_family', 'sport', 'title_prefix',
                                    'header_size', 'divider_size']
            for param in LAYOUT_PARAMS_IMPORT:
                cli_val = getattr(args, param)
                if cli_val is None and param in saved_layout:
                    setattr(args, param, saved_layout[param])

            errors = []

            # Gym highlights - always code-generated for proper gym name spacing
            try:
                gym_highlights_path = os.path.join(args.output, 'gym_highlights.pdf')
                tmp = _tmp_path_for(gym_highlights_path)
                generate_gym_highlights_pdf(db_path, config.meet_name, tmp,
                                            year=args.year, state=args.state,
                                            name_sort=args.name_sort)
                actual = _safe_move(tmp, gym_highlights_path)
                print(f"Generated {actual}")
            except Exception as e:
                print(f"ERROR generating gym_highlights.pdf: {e}")
                errors.append(('gym_highlights', str(e)))

            # Order forms -always use 8.5x11 back_of_shirt.pdf for back pages
            # (even when importing a legal-size IDML)
            _letter_shirt = os.path.join(args.output, 'back_of_shirt.pdf')
            _order_shirt = _letter_shirt if os.path.exists(_letter_shirt) else pdf_path
            try:
                order_pdf_path = os.path.join(args.output, 'order_forms.pdf')
                tmp = _tmp_path_for(order_pdf_path)
                generate_order_forms_pdf(db_path, config.meet_name, tmp,
                                         year=args.year, state=args.state,
                                         state_abbrev=args.state_abbrev,
                                         postmark_date=args.postmark_date,
                                         online_date=args.online_date,
                                         ship_date=args.ship_date,
                                         name_sort=args.name_sort,
                                         shirt_pdf_path=_order_shirt)
                actual = _safe_move(tmp, order_pdf_path)
                print(f"Generated {actual}")
            except Exception as e:
                print(f"ERROR generating order_forms.pdf: {e}")
                errors.append(('order_forms', str(e)))

            # Meet summary
            try:
                summary_path = os.path.join(args.output, 'meet_summary.txt')
                generate_meet_summary(db_path, config.meet_name, summary_path,
                                      line_spacing=args.line_spacing,
                                      level_gap=args.level_gap,
                                      max_fill=args.max_fill,
                                      max_font_size=args.max_font_size,
                                      max_shirt_pages=args.max_shirt_pages,
                                      title1_size=args.title1_size,
                                      title2_size=args.title2_size,
                                      level_groups=args.level_groups,
                                      exclude_levels=args.exclude_levels)
                print(f"Generated {summary_path}")
            except Exception as e:
                print(f"ERROR generating meet_summary.txt: {e}")
                errors.append(('summary', str(e)))

            # Copy the imported IDML to the output folder for round-tripping
            try:
                import shutil
                idml_dest = os.path.join(args.output, 'back_of_shirt.idml')
                shutil.copy2(args.import_idml, idml_dest)
                print(f"Copied {idml_dest}")
            except Exception as e:
                print(f"ERROR copying IDML: {e}")
                errors.append(('idml_copy', str(e)))

            if errors:
                print(f"\nDone with {len(errors)} error(s):")
                for name, msg in errors:
                    print(f"  - {name}: {msg}")
                sys.exit(1)
        else:
            if not os.path.exists(db_path):
                print(f"Note: Database not found at {db_path}. "
                      "Only the shirt PDF was generated (no order forms or gym highlights).")
            else:
                print(f"Note: No data for '{config.meet_name}' in database. "
                      "Only the shirt PDF was generated (no order forms or gym highlights).")

        print("\nDone!")
        sys.exit(0)

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

        # When shirt regenerates, also regenerate all shirt-dependent outputs
        # so they use the updated layout (page groups, font sizes, etc.)
        if 'shirt' in regen_set:
            for dep in ('summary', 'idml', 'order_forms', 'gym_highlights'):
                regen_set.add(dep)

        print(f"Regenerating outputs from existing database: {', '.join(regen_set)}")
    else:
        regen_set = set()
        do_all = True  # Full pipeline generates everything

        # Select adapter
        if args.source == 'scorecat':
            adapter = ScoreCatAdapter()
        elif args.source == 'mso_pdf':
            adapter = PdfAdapter()
        elif args.source == 'mso_html':
            adapter = HtmlAdapter(strip_parenthetical=args.strip_parenthetical)
        elif args.source == 'generic':
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

        # Normalize gym names
        result = normalize_gyms(athletes, gym_map_path=args.gym_map)
        athletes = result['normalized_athletes']
        print_gym_report(result['gym_report'])

        # Build database
        print(f"Building database at {db_path}...")
        build_database(db_path, config, athletes)

    # Auto-detect division ordering with explicit override support
    from python.core.division_detector import detect_division_order
    _explicit = None
    if args.division_order:
        _explicit = [s.strip() for s in args.division_order.split(',') if s.strip()]
    division_order, unknown_divs = detect_division_order(
        db_path, config.meet_name, explicit_order=_explicit)
    print(f"Division order ({len(division_order)} divisions): {list(division_order.keys())}")
    if unknown_divs:
        print(f"UNKNOWN_DIVISIONS: {', '.join(unknown_divs)}")
        print("The ordering of these divisions could not be auto-detected. "
              "They are currently sorted after all known divisions. "
              "To fix: re-run with --division-order specifying all divisions "
              "in youngest-to-oldest order, e.g. --division-order \"Petite,Cadet,Junior,Senior\"")

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

    # Merge: CLI (if explicitly set, i.e. not None) > saved > default (None)
    # NOTE: level_groups, exclude_levels, and page_size are intentionally NOT
    # persisted here — they are per-run overrides, not sticky layout settings.
    # Persisting them caused bugs where subsequent runs applied stale exclusions.
    LAYOUT_PARAMS = ['line_spacing', 'level_gap', 'max_fill',
                     'min_font_size', 'max_font_size', 'max_shirt_pages',
                     'title1_size', 'title2_size',
                     'copyright', 'accent_color', 'font_family',
                     'sport', 'title_prefix', 'header_size', 'divider_size']
    for param in LAYOUT_PARAMS:
        cli_val = getattr(args, param)
        if cli_val is None and param in saved_layout:
            setattr(args, param, saved_layout[param])

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

    if 'csv' in regen_set:
        try:
            csv_path = os.path.join(args.output, 'winners_sheet.csv')
            generate_winners_csv(db_path, config.meet_name, csv_path, division_order)
            print(f"Generated {csv_path}")
        except Exception as e:
            print(f"ERROR generating winners_sheet.csv: {e}")
            errors.append(('csv', str(e)))

    # Determine which page groups need legal-size output
    _legal_groups = args.page_size_legal
    if args.page_size == 'legal' and not _legal_groups:
        _legal_groups = ['']  # empty string matches all groups

    # Pre-check names for suspicious content before generating shirt
    if do_all or 'shirt' in regen_set:
        from python.core.pdf_generator import precompute_shirt_data as _pre_check
        _check = _pre_check(db_path, config.meet_name, name_sort=args.name_sort)
        _flagged = _check.get('flagged_names', [])
        _modified = _check.get('modified_names', [])
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

    if do_all or 'shirt' in regen_set:
        try:
            pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
            tmp = _tmp_path_for(pdf_path)
            generate_shirt_pdf(db_path, config.meet_name, tmp,
                               year=args.year, state=args.state,
                               line_spacing=args.line_spacing,
                               level_gap=args.level_gap,
                               max_fill=args.max_fill,
                               min_font_size=args.min_font_size,
                               max_font_size=args.max_font_size,
                               name_sort=args.name_sort,
                               max_shirt_pages=args.max_shirt_pages,
                               title1_size=args.title1_size,
                               title2_size=args.title2_size,
                               level_groups=args.level_groups,
                               exclude_levels=args.exclude_levels,
                               copyright=args.copyright,
                               accent_color=args.accent_color,
                               font_family=args.font_family,
                               sport=args.sport,
                               title_prefix=args.title_prefix,
                               header_size=args.header_size,
                               divider_size=args.divider_size)
            actual = _safe_move(tmp, pdf_path)
            print(f"Generated {actual}")
            # Save effective layout params so future runs reuse them
            effective_layout = {}
            for param in LAYOUT_PARAMS:
                val = getattr(args, param)
                if val is not None:
                    effective_layout[param] = val
            with open(layout_json, 'w') as f:
                json.dump(effective_layout, f, indent=2)
        except Exception as e:
            print(f"ERROR generating back_of_shirt.pdf: {e}")
            errors.append(('shirt', str(e)))

        # Generate 8.5x14 versions for specified page groups
        if _legal_groups:
            from python.core.pdf_generator import PAGE_H_LEGAL
            _filter = _legal_groups if any(_legal_groups) else None
            try:
                legal_pdf = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')
                tmp = _tmp_path_for(legal_pdf)
                generate_shirt_pdf(db_path, config.meet_name, tmp,
                                   year=args.year, state=args.state,
                                   line_spacing=args.line_spacing,
                                   level_gap=args.level_gap,
                                   max_fill=args.max_fill,
                                   min_font_size=args.min_font_size,
                                   max_font_size=args.max_font_size,
                                   name_sort=args.name_sort,
                                   max_shirt_pages=args.max_shirt_pages,
                                   title1_size=args.title1_size,
                                   title2_size=args.title2_size,
                                   level_groups=args.level_groups,
                                   exclude_levels=args.exclude_levels,
                                   copyright=args.copyright,
                                   accent_color=args.accent_color,
                                   font_family=args.font_family,
                                   sport=args.sport,
                                   title_prefix=args.title_prefix,
                                   header_size=args.header_size,
                                   divider_size=args.divider_size,
                                   page_h=PAGE_H_LEGAL,
                                   page_group_filter=_filter)
                actual = _safe_move(tmp, legal_pdf)
                print(f"Generated {actual} (8.5x14)")
            except Exception as e:
                print(f"ERROR generating back_of_shirt_8.5x14.pdf: {e}")
                errors.append(('shirt_legal', str(e)))

    # ICML generation removed -only generated on explicit --regenerate icml request
    if 'icml' in regen_set:
        try:
            icml_path = os.path.join(args.output, 'back_of_shirt.icml')
            generate_shirt_icml(db_path, config.meet_name, icml_path,
                                year=args.year, state=args.state,
                                line_spacing=args.line_spacing,
                                level_gap=args.level_gap,
                                max_fill=args.max_fill,
                                min_font_size=args.min_font_size,
                                max_font_size=args.max_font_size,
                                name_sort=args.name_sort,
                                max_shirt_pages=args.max_shirt_pages,
                                title1_size=args.title1_size,
                                title2_size=args.title2_size,
                                level_groups=args.level_groups,
                                exclude_levels=args.exclude_levels,
                                copyright=args.copyright,
                                sport=args.sport,
                                title_prefix=args.title_prefix,
                                accent_color=args.accent_color,
                                font_family=args.font_family,
                                header_size=args.header_size,
                                divider_size=args.divider_size)
            print(f"Generated {icml_path}")
        except Exception as e:
            print(f"ERROR generating back_of_shirt.icml: {e}")
            errors.append(('icml', str(e)))

    if do_all or 'idml' in regen_set:
        try:
            idml_path = os.path.join(args.output, 'back_of_shirt.idml')
            generate_shirt_idml(db_path, config.meet_name, idml_path,
                                year=args.year, state=args.state,
                                line_spacing=args.line_spacing,
                                level_gap=args.level_gap,
                                max_fill=args.max_fill,
                                min_font_size=args.min_font_size,
                                max_font_size=args.max_font_size,
                                name_sort=args.name_sort,
                                max_shirt_pages=args.max_shirt_pages,
                                title1_size=args.title1_size,
                                title2_size=args.title2_size,
                                level_groups=args.level_groups,
                                exclude_levels=args.exclude_levels,
                                copyright=args.copyright,
                                sport=args.sport,
                                title_prefix=args.title_prefix,
                                accent_color=args.accent_color,
                                font_family=args.font_family,
                                header_size=args.header_size,
                                divider_size=args.divider_size)
            print(f"Generated {idml_path}")
        except Exception as e:
            print(f"ERROR generating back_of_shirt.idml: {e}")
            errors.append(('idml', str(e)))

        # Generate 8.5x14 IDML for specified page groups
        if _legal_groups:
            from python.core.pdf_generator import PAGE_H_LEGAL
            _filter = _legal_groups if any(_legal_groups) else None
            try:
                legal_idml = os.path.join(args.output, 'back_of_shirt_8.5x14.idml')
                generate_shirt_idml(db_path, config.meet_name, legal_idml,
                                    year=args.year, state=args.state,
                                    line_spacing=args.line_spacing,
                                    level_gap=args.level_gap,
                                    max_fill=args.max_fill,
                                    min_font_size=args.min_font_size,
                                    max_font_size=args.max_font_size,
                                    name_sort=args.name_sort,
                                    max_shirt_pages=args.max_shirt_pages,
                                    title1_size=args.title1_size,
                                    title2_size=args.title2_size,
                                    level_groups=args.level_groups,
                                    exclude_levels=args.exclude_levels,
                                    copyright=args.copyright,
                                    sport=args.sport,
                                    title_prefix=args.title_prefix,
                                    accent_color=args.accent_color,
                                    font_family=args.font_family,
                                    header_size=args.header_size,
                                    divider_size=args.divider_size,
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
            generate_order_forms_pdf(db_path, config.meet_name, tmp,
                                     year=args.year, state=args.state,
                                     state_abbrev=args.state_abbrev,
                                     postmark_date=args.postmark_date,
                                     online_date=args.online_date,
                                     ship_date=args.ship_date,
                                     line_spacing=args.line_spacing,
                                     level_gap=args.level_gap,
                                     max_fill=args.max_fill,
                                     min_font_size=args.min_font_size,
                                     max_font_size=args.max_font_size,
                                     name_sort=args.name_sort,
                                     max_shirt_pages=args.max_shirt_pages,
                                     title1_size=args.title1_size,
                                     title2_size=args.title2_size,
                                     level_groups=args.level_groups,
                                     exclude_levels=args.exclude_levels,
                                     copyright=args.copyright,
                                     accent_color=args.accent_color,
                                     font_family=args.font_family,
                                     sport=args.sport,
                                     title_prefix=args.title_prefix,
                                     header_size=args.header_size,
                                     divider_size=args.divider_size,
                                     shirt_pdf_path=_shirt_path)
            actual = _safe_move(tmp, order_pdf_path)
            print(f"Generated {actual}")
        except Exception as e:
            print(f"ERROR generating order_forms.pdf: {e}")
            errors.append(('order_forms', str(e)))

    if do_all or 'gym_highlights' in regen_set:
        letter_shirt = os.path.join(args.output, 'back_of_shirt.pdf')
        legal_shirt = os.path.join(args.output, 'back_of_shirt_8.5x14.pdf')
        # Only use legal shirt for exclusion/generation when it was explicitly requested
        _has_legal = _legal_groups and os.path.exists(legal_shirt)

        # Always use code-generated gym highlights (not PDF overlay) because
        # the overlay approach has no room for the gym name between title and oval.
        # The code-generated version builds pages from scratch with proper spacing.
        _gh_args = dict(
            year=args.year, state=args.state,
            line_spacing=args.line_spacing, level_gap=args.level_gap,
            max_fill=args.max_fill, min_font_size=args.min_font_size,
            max_font_size=args.max_font_size, name_sort=args.name_sort,
            max_shirt_pages=args.max_shirt_pages,
            title1_size=args.title1_size, title2_size=args.title2_size,
            level_groups=args.level_groups, exclude_levels=args.exclude_levels,
            copyright=args.copyright, accent_color=args.accent_color,
            font_family=args.font_family, sport=args.sport,
            title_prefix=args.title_prefix,
            header_size=args.header_size, divider_size=args.divider_size,
        )

        # Generate 8.5x14 gym highlights when legal was explicitly requested
        if _has_legal:
            try:
                from python.core.pdf_generator import PAGE_H_LEGAL
                gh_legal_path = os.path.join(args.output, 'gym_highlights_8.5x14.pdf')
                tmp = _tmp_path_for(gh_legal_path)
                generate_gym_highlights_pdf(db_path, config.meet_name, tmp,
                                            page_h=PAGE_H_LEGAL, **_gh_args)
                actual = _safe_move(tmp, gh_legal_path)
                print(f"Generated {actual} (8.5x14)")
            except Exception as e:
                print(f"ERROR generating gym_highlights_8.5x14.pdf: {e}")
                errors.append(('gym_highlights_legal', str(e)))

        # Generate 8.5x11 gym highlights
        try:
            gym_highlights_path = os.path.join(args.output, 'gym_highlights.pdf')
            tmp = _tmp_path_for(gym_highlights_path)
            generate_gym_highlights_pdf(db_path, config.meet_name, tmp, **_gh_args)
            actual = _safe_move(tmp, gym_highlights_path)
            print(f"Generated {actual}")
        except Exception as e:
            print(f"ERROR generating gym_highlights.pdf: {e}")
            errors.append(('gym_highlights', str(e)))

    if do_all or 'summary' in regen_set:
        try:
            summary_path = os.path.join(args.output, 'meet_summary.txt')
            generate_meet_summary(db_path, config.meet_name, summary_path,
                                  line_spacing=args.line_spacing,
                                  level_gap=args.level_gap,
                                  max_fill=args.max_fill,
                                  max_font_size=args.max_font_size,
                                  max_shirt_pages=args.max_shirt_pages,
                                  title1_size=args.title1_size,
                                  title2_size=args.title2_size,
                                  level_groups=args.level_groups,
                                  exclude_levels=args.exclude_levels)
            print(f"Generated {summary_path}")
        except Exception as e:
            print(f"ERROR generating meet_summary.txt: {e}")
            errors.append(('summary', str(e)))

    # Clean up any leftover temp files in the output directory
    import glob
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
