"""Tests for the refactored Python core.

Verifies that the refactored adapters, db_builder, and output_generator
produce results matching the prototype code.
"""

import os
import sys
import sqlite3
import tempfile
import pytest

# Add project root to path
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from python.core.models import MeetConfig
from python.core.db_builder import build_database
from python.core.output_generator import (
    generate_back_of_shirt, generate_order_forms, generate_winners_csv
)
from python.adapters.scorecat_adapter import ScoreCatAdapter
from python.adapters.html_adapter import HtmlAdapter

REFERENCE_DIR = os.path.join(PROJECT_ROOT, 'tests', 'reference_data')


# ─── Iowa (ScoreCat) ────────────────────────────────────────────────

IA_CONFIG = MeetConfig(
    state='Iowa',
    meet_name='2025 Iowa Dev State Championships',
    association='USAG',
    source_type='scorecat',
    title_lines=('2025 Gymnastics', 'State Champions of Iowa', 'Levels 2-10'),
    division_order={
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
)


@pytest.fixture(scope='module')
def ia_db(tmp_path_factory):
    """Build Iowa database once for all Iowa tests."""
    tmpdir = tmp_path_factory.mktemp('iowa')
    db_path = str(tmpdir / 'ia_meet_results.db')

    adapter = ScoreCatAdapter()
    athletes = adapter.parse(os.path.join(REFERENCE_DIR, 'ia_athletes.json'))
    build_database(db_path, IA_CONFIG, athletes)

    return db_path, athletes


class TestIowaAdapter:
    def test_parse_count(self, ia_db):
        _, athletes = ia_db
        assert len(athletes) == 413, f"Expected 413 athletes, got {len(athletes)}"

    def test_has_event_ranks(self, ia_db):
        _, athletes = ia_db
        # ScoreCat adapter should include per-event ranks
        for a in athletes:
            assert 'vault_rank' in a
            assert 'bars_rank' in a
            assert 'beam_rank' in a
            assert 'floor_rank' in a
            assert 'aa_rank' in a


class TestIowaDatabase:
    def test_results_count(self, ia_db):
        db_path, _ = ia_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM results WHERE meet_name = ?",
                    (IA_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 413

    def test_winners_count(self, ia_db):
        db_path, _ = ia_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM winners WHERE meet_name = ?",
                    (IA_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 181, f"Expected 181 winners, got {count}"

    def test_has_state_columns(self, ia_db):
        db_path, _ = ia_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT state, meet_name, association FROM results")
        row = cur.fetchone()
        conn.close()
        assert row == ('Iowa', '2025 Iowa Dev State Championships', 'USAG')


class TestIowaOutputs:
    def test_back_of_shirt(self, ia_db, tmp_path):
        db_path, _ = ia_db
        output = str(tmp_path / 'ia_back_of_shirt.md')
        generate_back_of_shirt(
            db_path, IA_CONFIG.meet_name, output,
            shirt_title='2025 Iowa Dev State Champions',
            format='level_first'
        )
        expected_path = os.path.join(REFERENCE_DIR, 'ia_back_of_shirt_expected.md')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Back of shirt content does not match expected"

    def test_order_forms(self, ia_db, tmp_path):
        db_path, _ = ia_db
        output = str(tmp_path / 'ia_order_forms.txt')
        generate_order_forms(db_path, IA_CONFIG.meet_name, output)
        expected_path = os.path.join(REFERENCE_DIR, 'ia_order_forms_expected.txt')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Order forms content does not match expected"

    def test_winners_csv(self, ia_db, tmp_path):
        db_path, _ = ia_db
        output = str(tmp_path / 'ia_winners.csv')
        generate_winners_csv(db_path, IA_CONFIG.meet_name, output,
                             IA_CONFIG.division_order)
        expected_path = os.path.join(REFERENCE_DIR, 'ia_winners_expected.csv')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Winners CSV content does not match expected"


# ─── Colorado (MSO HTML) ────────────────────────────────────────────

CO_CONFIG = MeetConfig(
    state='Colorado',
    meet_name='2025 Colorado State Championships',
    association='USAG',
    source_type='mso_html',
    division_order={
        'Child': 1, 'Youth': 2,
        'Jr. A': 3, 'Jr. B': 4, 'Jr. C': 5,
        'Junior': 6,
        'Sr. A': 7, 'Sr. B': 8,
        'Senior': 9,
    },
)


@pytest.fixture(scope='module')
def co_db(tmp_path_factory):
    """Build Colorado database once for all Colorado tests."""
    tmpdir = tmp_path_factory.mktemp('colorado')
    db_path = str(tmpdir / 'co_meet_results.db')

    adapter = HtmlAdapter(strip_parenthetical=False)
    athletes = adapter.parse(os.path.join(REFERENCE_DIR, 'co_state_data.tsv'))
    build_database(db_path, CO_CONFIG, athletes)

    return db_path, athletes


class TestColoradoAdapter:
    def test_parse_count(self, co_db):
        _, athletes = co_db
        assert len(athletes) == 372, f"Expected 372 athletes, got {len(athletes)}"


class TestColoradoDatabase:
    def test_results_count(self, co_db):
        db_path, _ = co_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM results WHERE meet_name = ?",
                    (CO_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 372

    def test_winners_count(self, co_db):
        db_path, _ = co_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM winners WHERE meet_name = ?",
                    (CO_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 149, f"Expected 149 winners, got {count}"


# ─── Utah (MSO HTML with parenthetical stripping) ───────────────────

UT_CONFIG = MeetConfig(
    state='Utah',
    meet_name='2025 Utah DP State Championships',
    association='USAG',
    source_type='mso_html',
    division_order={
        'CH A': 1, 'CH B': 2, 'CH C': 3, 'CH D': 4,
        'Child': 5,
        'JR A': 6, 'Jr A': 6, 'JR B': 7, 'Jr B': 7,
        'JR C': 8, 'Jr C': 8, 'JR D': 9, 'Jr D': 9,
        'Junior': 10,
        'SR': 11, 'SR A': 12, 'Sr A': 12, 'SR B': 13, 'Sr B': 13,
        'SR C': 14, 'Sr C': 14, 'SR D': 15, 'Sr D': 15,
        'Senior': 16,
    },
)


@pytest.fixture(scope='module')
def ut_db(tmp_path_factory):
    """Build Utah database once for all Utah tests."""
    tmpdir = tmp_path_factory.mktemp('utah')
    db_path = str(tmpdir / 'ut_meet_results.db')

    adapter = HtmlAdapter(strip_parenthetical=True)
    athletes = adapter.parse(os.path.join(REFERENCE_DIR, 'ut_state_data.tsv'))
    build_database(db_path, UT_CONFIG, athletes)

    return db_path, athletes


class TestUtahAdapter:
    def test_parse_count(self, ut_db):
        _, athletes = ut_db
        assert len(athletes) == 686, f"Expected 686 athletes, got {len(athletes)}"


class TestUtahDatabase:
    def test_results_count(self, ut_db):
        db_path, _ = ut_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM results WHERE meet_name = ?",
                    (UT_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 686

    def test_winners_count(self, ut_db):
        db_path, _ = ut_db
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM winners WHERE meet_name = ?",
                    (UT_CONFIG.meet_name,))
        count = cur.fetchone()[0]
        conn.close()
        assert count == 302, f"Expected 302 winners, got {count}"


class TestUtahOutputs:
    """Test Utah outputs against the co_*_expected files.

    The expected output files with 'co_' prefix were actually generated
    from Utah data using the event-first format prototype.
    """
    def test_back_of_shirt(self, ut_db, tmp_path):
        db_path, _ = ut_db
        output = str(tmp_path / 'ut_back_of_shirt.md')
        generate_back_of_shirt(
            db_path, UT_CONFIG.meet_name, output,
            format='event_first'
        )
        expected_path = os.path.join(REFERENCE_DIR, 'co_back_of_shirt_expected.md')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Back of shirt content does not match expected"

    def test_order_forms(self, ut_db, tmp_path):
        db_path, _ = ut_db
        output = str(tmp_path / 'ut_order_forms.txt')
        generate_order_forms(db_path, UT_CONFIG.meet_name, output)
        expected_path = os.path.join(REFERENCE_DIR, 'co_order_forms_expected.txt')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Order forms content does not match expected"

    def test_winners_csv(self, ut_db, tmp_path):
        db_path, _ = ut_db
        output = str(tmp_path / 'ut_winners.csv')
        generate_winners_csv(db_path, UT_CONFIG.meet_name, output,
                             UT_CONFIG.division_order)
        expected_path = os.path.join(REFERENCE_DIR, 'co_winners_expected.csv')
        with open(output) as f:
            actual = f.read()
        with open(expected_path) as f:
            expected = f.read()
        assert actual == expected, "Winners CSV content does not match expected"
