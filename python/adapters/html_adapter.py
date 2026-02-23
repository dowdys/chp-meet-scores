"""Adapter for parsing MeetScoresOnline HTML/TSV exports (e.g. Colorado, Utah)."""

import re
from .base import BaseAdapter


class HtmlAdapter(BaseAdapter):
    """Parse gymnastics meet results from MeetScoresOnline TSV files.

    TSV columns: name, gym, session, level, division,
                 vault, vault_rank, bars, bars_rank, beam, beam_rank,
                 floor, floor_rank, aa, aa_rank

    Args:
        strip_parenthetical: If True, strip parenthetical event notations
                             from names (e.g. Utah data has these).
    """

    def __init__(self, strip_parenthetical: bool = False):
        self.strip_parenthetical = strip_parenthetical

    def parse(self, data_path: str) -> list[dict]:
        """Parse a TSV file and return list of athlete dicts."""
        athletes = []
        with open(data_path, 'r') as f:
            f.readline()  # skip header
            for line in f:
                parts = line.strip().split('\t')
                if len(parts) < 15:
                    parts.extend([''] * (15 - len(parts)))

                name = parts[0].strip()
                if self.strip_parenthetical:
                    name = re.sub(r'\s*\([^)]*\)\s*', '', name)

                gym = parts[1].strip()
                session = parts[2].strip()
                level = parts[3].strip()
                division = parts[4].strip()

                vault = self._parse_score(parts[5])
                bars = self._parse_score(parts[7])
                beam = self._parse_score(parts[9])
                floor = self._parse_score(parts[11])
                aa = self._parse_score(parts[13])
                aa_rank = parts[14].strip()

                athletes.append({
                    'name': name,
                    'gym': gym,
                    'session': session,
                    'level': level,
                    'division': division,
                    'vault': vault,
                    'bars': bars,
                    'beam': beam,
                    'floor': floor,
                    'aa': aa,
                    'rank': aa_rank,
                    'num': '',
                })

        return athletes

    @staticmethod
    def _parse_score(s: str):
        """Parse a score string. Returns None for empty or invalid, None for 0."""
        s = s.strip()
        if not s:
            return None
        try:
            val = float(s)
            return val if val > 0 else None
        except ValueError:
            return None
