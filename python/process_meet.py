#!/usr/bin/env python3
"""CLI entry point for processing a gymnastics meet.

Usage:
    python process_meet.py --source scorecat --data ia_athletes.json \\
        --state Iowa --meet "2025 Iowa Dev State Championships" \\
        --association USAG --output ./output/
"""

import argparse
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from python.core.models import MeetConfig
from python.core.db_builder import build_database
from python.core.output_generator import (
    generate_back_of_shirt, generate_order_forms, generate_winners_csv
)
from python.core.pdf_generator import generate_shirt_pdf
from python.adapters.scorecat_adapter import ScoreCatAdapter
from python.adapters.html_adapter import HtmlAdapter
from python.adapters.pdf_adapter import PdfAdapter


# Default division orders per state
DIVISION_ORDERS = {
    'Iowa': {
        'CH A': 1, 'CH B': 2, 'CH C': 3, 'CH D': 4,
        'Ch A': 1, 'Ch B': 2, 'Ch C': 3, 'Ch D': 4,
        'Child': 5,
        'JR A': 6, 'Jr A': 6, 'JR B': 7, 'Jr B': 7,
        'JR C': 8, 'Jr C': 8, 'JR D': 9, 'Jr D': 9,
        'Junior': 10,
        'SR A': 11, 'Sr A': 11, 'SR B': 12, 'Sr B': 12,
        'SR C': 13, 'Sr C': 13, 'SR D': 14, 'Sr D': 14,
        'Senior': 15,
    },
    'Colorado': {
        'Child': 1, 'Youth': 2,
        'Jr. A': 3, 'Jr. B': 4, 'Jr. C': 5,
        'Junior': 6,
        'Sr. A': 7, 'Sr. B': 8,
        'Senior': 9,
    },
    'Utah': {
        'CH A': 1, 'CH B': 2, 'CH C': 3, 'CH D': 4,
        'Child': 5,
        'JR A': 6, 'Jr A': 6, 'JR B': 7, 'Jr B': 7,
        'JR C': 8, 'Jr C': 8, 'JR D': 9, 'Jr D': 9,
        'Junior': 10,
        'SR': 11, 'SR A': 12, 'Sr A': 12, 'SR B': 13, 'Sr B': 13,
        'SR C': 14, 'Sr C': 14, 'SR D': 15, 'Sr D': 15,
        'Senior': 16,
    },
}


def main():
    parser = argparse.ArgumentParser(description='Process a gymnastics meet')
    parser.add_argument('--source', required=True,
                        choices=['scorecat', 'mso_pdf', 'mso_html'],
                        help='Data source type')
    parser.add_argument('--data', required=True, help='Path to input data file')
    parser.add_argument('--state', required=True, help='State name')
    parser.add_argument('--meet', required=True, help='Meet name')
    parser.add_argument('--association', default='USAG',
                        choices=['USAG', 'AAU'], help='Association')
    parser.add_argument('--output', required=True, help='Output directory')
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

    args = parser.parse_args()

    # Build title lines
    title_lines = tuple(l for l in [args.title_line1, args.title_line2, args.title_line3] if l)

    # Get division order
    division_order = DIVISION_ORDERS.get(args.state, {})

    config = MeetConfig(
        state=args.state,
        meet_name=args.meet,
        association=args.association,
        source_type=args.source,
        title_lines=title_lines,
        division_order=division_order,
    )

    # Select adapter
    if args.source == 'scorecat':
        adapter = ScoreCatAdapter()
    elif args.source == 'mso_pdf':
        adapter = PdfAdapter()
    elif args.source == 'mso_html':
        adapter = HtmlAdapter(strip_parenthetical=args.strip_parenthetical)
    else:
        print(f"Unknown source type: {args.source}")
        sys.exit(1)

    # Parse data
    print(f"Parsing {args.data}...")
    athletes = adapter.parse(args.data)
    print(f"Parsed {len(athletes)} athletes")

    # Build database
    os.makedirs(args.output, exist_ok=True)
    db_path = os.path.join(args.output, 'meet_results.db')
    print(f"Building database at {db_path}...")
    build_database(db_path, config, athletes)

    # Generate outputs
    shirt_path = os.path.join(args.output, 'back_of_shirt.md')
    generate_back_of_shirt(db_path, config.meet_name, shirt_path,
                           shirt_title=args.shirt_title,
                           format=args.shirt_format)
    print(f"Generated {shirt_path}")

    orders_path = os.path.join(args.output, 'order_forms_by_gym.txt')
    generate_order_forms(db_path, config.meet_name, orders_path)
    print(f"Generated {orders_path}")

    csv_path = os.path.join(args.output, 'winners_sheet.csv')
    generate_winners_csv(db_path, config.meet_name, csv_path, division_order)
    print(f"Generated {csv_path}")

    # Generate PDF if title lines provided
    if title_lines:
        pdf_path = os.path.join(args.output, 'back_of_shirt.pdf')
        generate_shirt_pdf(db_path, config.meet_name, pdf_path, title_lines)
        print(f"Generated {pdf_path}")

    print("\nDone!")


if __name__ == '__main__':
    main()
