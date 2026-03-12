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
import sys

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
from python.core.pdf_generator import generate_shirt_pdf, generate_gym_highlights_pdf
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


def main():
    parser = argparse.ArgumentParser(description='Process a gymnastics meet')
    parser.add_argument('--source',
                        choices=['scorecat', 'mso_pdf', 'mso_html', 'generic'],
                        help='Data source type (required unless --regenerate)')
    parser.add_argument('--data', nargs='+', help='Input data file(s) (required unless --regenerate)')
    parser.add_argument('--state', required=True, help='State name')
    parser.add_argument('--meet', required=True, help='Meet name')
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
                             'Values: shirt, icml, idml, order_forms, gym_highlights, summary, all. '
                             'Legacy: order_txt, csv (only on explicit request). '
                             'E.g. --regenerate shirt icml  or  --regenerate all')
    parser.add_argument('--import-idml', default=None,
                        help='Import a finalized IDML file (edited in InDesign) and convert it to '
                             'the definitive back_of_shirt.pdf. Regenerates order forms and gym '
                             'highlights using the imported layout. The IDML must contain embedded '
                             'meet metadata (generated by this app).')

    args = parser.parse_args()

    # --source and --data are required unless --regenerate or --import-idml is used
    if args.regenerate is None and not args.import_idml:
        if not args.source:
            parser.error('--source is required unless --regenerate or --import-idml is used')
        if not args.data:
            parser.error('--data is required unless --regenerate or --import-idml is used')

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

        pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
        print(f"Importing IDML: {args.import_idml}")
        metadata = idml_to_pdf(args.import_idml, pdf_path)
        if metadata:
            print(f"  Meet: {metadata.get('meet_name', '?')}")
            print(f"  State: {metadata.get('state', '?')}")
            print(f"  Year: {metadata.get('year', '?')}")
        print(f"Generated {pdf_path}")

        # Regenerate order forms and gym highlights using the existing DB
        if os.path.exists(db_path):
            # Load sticky layout params
            layout_json = os.path.join(args.output, 'shirt_layout.json')
            saved_layout = {}
            if os.path.exists(layout_json):
                try:
                    with open(layout_json, 'r') as f:
                        saved_layout = json.load(f)
                except (json.JSONDecodeError, OSError):
                    pass
            LAYOUT_PARAMS_IMPORT = ['line_spacing', 'level_gap', 'max_fill',
                                    'min_font_size', 'max_font_size', 'max_shirt_pages',
                                    'title1_size', 'title2_size', 'level_groups',
                                    'exclude_levels', 'copyright', 'accent_color',
                                    'font_family', 'sport', 'title_prefix',
                                    'header_size', 'divider_size']
            for param in LAYOUT_PARAMS_IMPORT:
                cli_val = getattr(args, param)
                if cli_val is None and param in saved_layout:
                    setattr(args, param, saved_layout[param])

            errors = []
            try:
                order_pdf_path = os.path.join(args.output, 'order_forms.pdf')
                generate_order_forms_pdf(db_path, config.meet_name, order_pdf_path,
                                         year=args.year, state=args.state,
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
                                         divider_size=args.divider_size)
                print(f"Generated {order_pdf_path}")
            except Exception as e:
                print(f"ERROR generating order_forms.pdf: {e}")
                errors.append(('order_forms', str(e)))
            try:
                gym_highlights_path = os.path.join(args.output, 'gym_highlights.pdf')
                generate_gym_highlights_pdf(db_path, config.meet_name, gym_highlights_path,
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
                print(f"Generated {gym_highlights_path}")
            except Exception as e:
                print(f"ERROR generating gym_highlights.pdf: {e}")
                errors.append(('gym_highlights', str(e)))

            if errors:
                print(f"\nDone with {len(errors)} error(s):")
                for name, msg in errors:
                    print(f"  - {name}: {msg}")
                sys.exit(1)
        else:
            print(f"Note: Database not found at {db_path}. "
                  "Only the shirt PDF was generated (no order forms or gym highlights).")

        print("\nDone!")
        sys.exit(0)

    # --regenerate mode: skip parsing/DB build, just regenerate specified outputs
    regen = args.regenerate
    if regen is not None:
        # --regenerate with no values means 'all'
        if len(regen) == 0:
            regen = ['all']
        regen_set = set(regen)
        do_all = 'all' in regen_set

        if not os.path.exists(db_path):
            print(f"Error: Database not found at {db_path}. Run full pipeline first.")
            sys.exit(1)

        # When shirt regenerates, also regenerate all shirt-dependent outputs
        # so they use the updated layout (page groups, font sizes, etc.)
        if 'shirt' in regen_set:
            for dep in ('summary', 'icml', 'idml', 'order_forms', 'gym_highlights'):
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

    # Auto-detect division ordering (uses DB data, caches to JSON)
    config_dir = os.path.dirname(os.path.abspath(db_path))
    division_order = get_division_order(db_path, config.meet_name,
                                        config.state, config_dir)
    print(f"Division order ({len(division_order)} divisions): {list(division_order.keys())}")

    # --- Sticky shirt layout params ---
    # After a user adjusts layout (e.g. --max-shirt-pages 2), those params
    # persist in shirt_layout.json so future runs use the same layout.
    # CLI args override saved params; saved params override defaults.
    layout_json = os.path.join(args.output, 'shirt_layout.json')
    saved_layout = {}
    if os.path.exists(layout_json):
        try:
            with open(layout_json, 'r') as f:
                saved_layout = json.load(f)
        except (json.JSONDecodeError, OSError):
            pass

    # Merge: CLI (if explicitly set, i.e. not None) > saved > default (None)
    LAYOUT_PARAMS = ['line_spacing', 'level_gap', 'max_fill',
                     'min_font_size', 'max_font_size', 'max_shirt_pages',
                     'title1_size', 'title2_size', 'level_groups',
                     'exclude_levels',
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

    if do_all or 'shirt' in regen_set:
        try:
            pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
            generate_shirt_pdf(db_path, config.meet_name, pdf_path,
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
            print(f"Generated {pdf_path}")
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

    if do_all or 'icml' in regen_set:
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

    if do_all or 'order_forms' in regen_set:
        try:
            order_pdf_path = os.path.join(args.output, 'order_forms.pdf')
            generate_order_forms_pdf(db_path, config.meet_name, order_pdf_path,
                                     year=args.year, state=args.state,
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
                                     divider_size=args.divider_size)
            print(f"Generated {order_pdf_path}")
        except Exception as e:
            print(f"ERROR generating order_forms.pdf: {e}")
            errors.append(('order_forms', str(e)))

    if do_all or 'gym_highlights' in regen_set:
        try:
            gym_highlights_path = os.path.join(args.output, 'gym_highlights.pdf')
            generate_gym_highlights_pdf(db_path, config.meet_name, gym_highlights_path,
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
            print(f"Generated {gym_highlights_path}")
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

    if errors:
        print(f"\nDone with {len(errors)} error(s):")
        for name, msg in errors:
            print(f"  - {name}: {msg}")
        sys.exit(1)
    else:
        print("\nDone!")


if __name__ == '__main__':
    main()
