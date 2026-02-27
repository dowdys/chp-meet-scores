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

# Add parent directory to path for imports (skip when frozen by PyInstaller)
if not getattr(sys, 'frozen', False):
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python.core.models import MeetConfig
from python.core.db_builder import build_database
from python.core.output_generator import (
    generate_order_forms, generate_winners_csv
)
from python.core.pdf_generator import generate_shirt_pdf
from python.core.order_form_generator import generate_order_forms_pdf
from python.core.gym_normalizer import normalize as normalize_gyms, print_gym_report
from python.adapters.scorecat_adapter import ScoreCatAdapter
from python.adapters.html_adapter import HtmlAdapter
from python.adapters.pdf_adapter import PdfAdapter
from python.adapters.generic_adapter import GenericAdapter
from python.core.division_detector import get_division_order


def main():
    parser = argparse.ArgumentParser(description='Process a gymnastics meet')
    parser.add_argument('--source', required=True,
                        choices=['scorecat', 'mso_pdf', 'mso_html', 'generic'],
                        help='Data source type')
    parser.add_argument('--data', nargs='+', required=True, help='Input data file(s)')
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

    args = parser.parse_args()

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
    os.makedirs(args.output, exist_ok=True)
    db_path = args.db if args.db else os.path.join(args.output, 'meet_results.db')
    # Ensure the db directory exists
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    print(f"Building database at {db_path}...")
    build_database(db_path, config, athletes)

    # Auto-detect division ordering (uses DB data, caches to JSON)
    config_dir = os.path.dirname(os.path.abspath(db_path))
    division_order = get_division_order(db_path, config.meet_name,
                                        config.state, config_dir)
    print(f"Division order ({len(division_order)} divisions): {list(division_order.keys())}")

    # Generate outputs
    orders_path = os.path.join(args.output, 'order_forms_by_gym.txt')
    generate_order_forms(db_path, config.meet_name, orders_path)
    print(f"Generated {orders_path}")

    csv_path = os.path.join(args.output, 'winners_sheet.csv')
    generate_winners_csv(db_path, config.meet_name, csv_path, division_order)
    print(f"Generated {csv_path}")

    # Always generate back-of-shirt PDF
    pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
    generate_shirt_pdf(db_path, config.meet_name, pdf_path,
                       year=args.year, state=args.state,
                       line_spacing=args.line_spacing,
                       level_gap=args.level_gap,
                       max_fill=args.max_fill,
                       min_font_size=args.min_font_size,
                       max_font_size=args.max_font_size)
    print(f"Generated {pdf_path}")

    # Generate order forms PDF
    order_pdf_path = os.path.join(args.output, 'order_forms.pdf')
    generate_order_forms_pdf(db_path, config.meet_name, order_pdf_path,
                             year=args.year)
    print(f"Generated {order_pdf_path}")

    print("\nDone!")


if __name__ == '__main__':
    main()
