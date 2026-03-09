#!/usr/bin/env python3
"""CLI entry point for processing a gymnastics meet.

Usage:
    python process_meet.py --source scorecat --data ia_athletes.json \\
        --state Iowa --meet "2025 Iowa Dev State Championships" \\
        --association USAG --output ./output/
"""

import argparse
import datetime
import os
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
    generate_order_forms, generate_winners_csv
)
from python.core.pdf_generator import generate_shirt_pdf, generate_gym_highlights_pdf
from python.core.icml_generator import generate_shirt_icml
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
    parser.add_argument('--year', default=str(datetime.datetime.now().year),
                        help='Championship year for PDF titles (default: current year)')
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
    parser.add_argument('--regenerate', nargs='*', default=None,
                        help='Skip parsing/DB build and regenerate specific outputs from existing DB. '
                             'Values: shirt, icml, order_forms, order_txt, csv, gym_highlights, summary, all. '
                             'E.g. --regenerate shirt icml  or  --regenerate all')

    args = parser.parse_args()

    # --source and --data are required unless --regenerate is used
    if args.regenerate is None:
        if not args.source:
            parser.error('--source is required unless --regenerate is used')
        if not args.data:
            parser.error('--data is required unless --regenerate is used')

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

        # Always regenerate summary when shirt regenerates (keeps page counts accurate)
        if 'shirt' in regen_set and 'summary' not in regen_set:
            regen_set.add('summary')

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

    # Generate outputs (all or selected)
    # Each output is wrapped in try/except so one failure doesn't block the rest
    errors = []

    if do_all or 'order_txt' in regen_set:
        try:
            orders_path = os.path.join(args.output, 'order_forms_by_gym.txt')
            generate_order_forms(db_path, config.meet_name, orders_path)
            print(f"Generated {orders_path}")
        except Exception as e:
            print(f"ERROR generating order_forms_by_gym.txt: {e}")
            errors.append(('order_txt', str(e)))

    if do_all or 'csv' in regen_set:
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
                               max_shirt_pages=args.max_shirt_pages)
            print(f"Generated {pdf_path}")
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
                                max_shirt_pages=args.max_shirt_pages)
            print(f"Generated {icml_path}")
        except Exception as e:
            print(f"ERROR generating back_of_shirt.icml: {e}")
            errors.append(('icml', str(e)))

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
                                     max_shirt_pages=args.max_shirt_pages)
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
                                        max_shirt_pages=args.max_shirt_pages)
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
                                  max_shirt_pages=args.max_shirt_pages)
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
