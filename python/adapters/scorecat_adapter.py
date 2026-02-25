"""Adapter for parsing ScoreCat Firestore JSON exports (e.g. Iowa)."""

import json
import re
from .base import BaseAdapter


class ScoreCatAdapter(BaseAdapter):
    """Parse gymnastics meet results from ScoreCat Firestore JSON.

    Handles both Firestore-style keys (event1Score, event1Rank) and
    ScoreCat API-style keys (vtScore, ubScore, vtRank, ubRank).
    """

    def parse(self, data_path: str) -> list[dict]:
        """Parse a JSON file and return list of athlete dicts."""
        with open(data_path, 'r') as f:
            raw_data = json.load(f)

        # Unwrap double-encoded JSON (chrome_execute_js saves JSON.stringify results)
        if isinstance(raw_data, str):
            try:
                raw_data = json.loads(raw_data)
            except json.JSONDecodeError:
                return []

        # Handle both array and object-with-array formats
        if isinstance(raw_data, list):
            raw_athletes = raw_data
        elif isinstance(raw_data, dict):
            for key in ('athletes', 'data', 'results', 'scores'):
                if key in raw_data and isinstance(raw_data[key], list):
                    raw_athletes = raw_data[key]
                    break
            else:
                raw_athletes = list(raw_data.values())
        else:
            return []

        athletes = []
        for raw in raw_athletes:
            a = self._extract_athlete(raw)
            if a['name']:
                athletes.append(a)

        return athletes

    def _extract_athlete(self, raw: dict) -> dict:
        """Extract a normalized athlete dict from a raw JSON object."""
        # Name fields
        first_name = self._get_field(raw, 'firstName', 'first_name', 'first', default='')
        last_name = self._get_field(raw, 'lastName', 'last_name', 'last', default='')
        full_name_raw = self._get_field(raw, 'fullName', 'full_name', 'name', default='')

        if first_name and last_name:
            name = self._clean_name(first_name, last_name)
        elif full_name_raw:
            parts = str(full_name_raw).strip().split()
            if len(parts) >= 2:
                name = self._clean_name(parts[0], ' '.join(parts[1:]))
            else:
                name = str(full_name_raw).strip().title()
        else:
            name = ''

        gym = str(self._get_field(raw, 'clubName', 'club_name', 'club', 'gym', 'team', default='')).strip()
        level = self._clean_prefix(self._get_field(raw, 'level', default=''), 'Level')
        division = self._clean_prefix(self._get_field(raw, 'division', default=''), 'Division')
        session = self._clean_prefix(
            self._get_field(raw, 'description', 'session', 'sessionDescription', default=''), 'Session')

        # Scores
        vault = self._parse_score(self._get_field(raw, 'vt', 'vtScore', 'event1Score', 'vault'))
        bars = self._parse_score(self._get_field(raw, 'ub', 'ubScore', 'event2Score', 'bars'))
        beam = self._parse_score(self._get_field(raw, 'bb', 'bbScore', 'event3Score', 'beam'))
        floor = self._parse_score(self._get_field(raw, 'fx', 'fxScore', 'event4Score', 'floor'))
        aa = self._parse_score(self._get_field(raw, 'aa', 'aaScore', 'event7Score'))

        # Ranks
        vault_rank = self._parse_rank(self._get_field(raw, 'vtRank', 'event1Rank', 'event1Place', 'vaultRank'))
        bars_rank = self._parse_rank(self._get_field(raw, 'ubRank', 'event2Rank', 'event2Place', 'barsRank'))
        beam_rank = self._parse_rank(self._get_field(raw, 'bbRank', 'event3Rank', 'event3Place', 'beamRank'))
        floor_rank = self._parse_rank(self._get_field(raw, 'fxRank', 'event4Rank', 'event4Place', 'floorRank'))
        aa_rank = self._parse_rank(self._get_field(raw, 'aaPlace', 'event7Rank', 'event7Place', 'aaRank'))

        return {
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
            'rank': str(aa_rank) if aa_rank is not None else '',
            'num': '',
            'vault_rank': vault_rank,
            'bars_rank': bars_rank,
            'beam_rank': beam_rank,
            'floor_rank': floor_rank,
            'aa_rank': aa_rank,
        }

    @staticmethod
    def _get_field(obj: dict, *keys, default=None):
        """Try multiple possible field names, return the first one found."""
        for key in keys:
            if key in obj and obj[key] is not None:
                return obj[key]
        return default

    @staticmethod
    def _clean_prefix(raw, prefix: str) -> str:
        """Clean 'Level: 8' -> '8', 'Division: Jr A' -> 'Jr A', etc."""
        if raw is None:
            return ''
        raw = str(raw).strip()
        raw = re.sub(rf'^{prefix}:\s*', '', raw, flags=re.IGNORECASE)
        return raw.strip()

    @staticmethod
    def _clean_last_name(raw) -> str:
        """Strip dash-notes like 'Holder- BB, FX' -> 'Holder'."""
        if raw is None:
            return ''
        raw = str(raw).strip()
        raw = re.sub(r'\s*-\s*[A-Z, ]+$', '', raw)
        return raw.strip()

    @classmethod
    def _clean_name(cls, first, last) -> str:
        """Build clean 'FirstName LastName' from components."""
        first = str(first).strip() if first else ''
        last = cls._clean_last_name(last)
        if first and last:
            return f"{first} {last}"
        return first or last or ''

    @staticmethod
    def _parse_score(val):
        """Parse a score value. Returns None for 0, null, empty, or invalid."""
        if val is None:
            return None
        if isinstance(val, (int, float)):
            return float(val) if val > 0 else None
        s = str(val).strip()
        if not s or s.lower() in ('nan', 'null', '0', '0.0', '0.000'):
            return None
        try:
            v = float(s)
            return v if v > 0 else None
        except ValueError:
            return None

    @staticmethod
    def _parse_rank(val):
        """Parse a rank value to integer. Handles '1T' tie notation."""
        if val is None:
            return None
        if isinstance(val, int):
            return val
        s = str(val).strip()
        if not s:
            return None
        s = re.sub(r'[Tt]$', '', s)
        try:
            return int(s)
        except ValueError:
            return None
