"""Adapter for generic JSON or TSV data from unknown sources (e.g. MyMeetScores).

Handles two formats:
  - JSON: Array of objects with keys like name, gym, session, level, division,
          vault, bars, beam, floor, aa, rank
  - TSV: Header row with column names, tab-separated values

Columns are matched by name (case-insensitive). Missing columns default to None/empty.
"""

import glob
import json
import os
import re
from .base import BaseAdapter


# Map common column name variations to our canonical names
COLUMN_ALIASES = {
    'name': 'name',
    'athlete': 'name',
    'gymnast': 'name',
    'gym': 'gym',
    'club': 'gym',
    'clubname': 'gym',
    'team': 'gym',
    'session': 'session',
    'sess': 'session',
    'level': 'level',
    'lvl': 'level',
    'division': 'division',
    'div': 'division',
    'vault': 'vault',
    'vt': 'vault',
    'bars': 'bars',
    'ub': 'bars',
    'beam': 'beam',
    'bb': 'beam',
    'floor': 'floor',
    'fx': 'floor',
    'aa': 'aa',
    'allaround': 'aa',
    'all_around': 'aa',
    'all-around': 'aa',
    'rank': 'rank',
    'place': 'rank',
    'num': 'num',
    'number': 'num',
}


class GenericAdapter(BaseAdapter):
    """Parse generic JSON or TSV data files."""

    def parse(self, data_path: str) -> list[dict]:
        """Auto-detect format (JSON vs TSV) and parse.

        data_path can be:
          - A single file
          - A directory (all .json files inside are loaded and merged)
          - A glob pattern (e.g. /path/to/data/js_result_*.json)
        """
        # If it's a directory, load all JSON files and merge
        if os.path.isdir(data_path):
            all_athletes = []
            for fpath in sorted(glob.glob(os.path.join(data_path, '*.json'))):
                all_athletes.extend(self._parse_single_file(fpath))
            return all_athletes

        # If it looks like a glob pattern, expand it
        if '*' in data_path or '?' in data_path:
            all_athletes = []
            for fpath in sorted(glob.glob(data_path)):
                all_athletes.extend(self._parse_single_file(fpath))
            return all_athletes

        # Single file
        return self._parse_single_file(data_path)

    def _parse_single_file(self, data_path: str) -> list[dict]:
        """Parse a single data file."""
        with open(data_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()

        # Try JSON first
        if content.startswith('[') or content.startswith('{'):
            try:
                data = json.loads(content)
                if isinstance(data, list):
                    return self._parse_json_array(data)
                elif isinstance(data, dict):
                    return self._parse_json_array([data])
            except json.JSONDecodeError:
                pass

        # Try as JSON-encoded string (auto-saved JS results are double-encoded)
        if content.startswith('"'):
            try:
                decoded = json.loads(content)
                if isinstance(decoded, str):
                    # It was a JSON-encoded string — parse the inner content
                    inner = decoded.strip()
                    if inner.startswith('['):
                        data = json.loads(inner)
                        return self._parse_json_array(data)
                    else:
                        # Probably TSV content
                        return self._parse_tsv_content(inner)
            except (json.JSONDecodeError, ValueError):
                pass

        # Fall back to TSV
        return self._parse_tsv_content(content)

    def _parse_json_array(self, data: list) -> list[dict]:
        """Parse a JSON array of athlete objects."""
        athletes = []
        for row in data:
            if not isinstance(row, dict):
                continue

            # Map keys to canonical names
            mapped = {}
            for key, value in row.items():
                canonical = COLUMN_ALIASES.get(key.lower().replace(' ', '').replace('_', ''))
                if canonical:
                    mapped[canonical] = value

            # Build name from firstName/lastName if 'name' not present
            if 'name' not in mapped:
                first = str(row.get('firstName', row.get('first_name', '') or '')).strip()
                last = str(row.get('lastName', row.get('last_name', '') or '')).strip()
                # Strip ScoreCat dash-notes like "Short-VT, FX" -> "Short"
                last = re.sub(r'\s*-\s*[A-Z, ]+$', '', last)
                if first and last:
                    mapped['name'] = f"{last}, {first}"
                elif first or last:
                    mapped['name'] = first or last

            if not mapped.get('name'):
                continue

            # Strip MSO event annotation suffixes from names
            # e.g. "Alley Perez IES V,Be,Fx" -> "Alley Perez", "Ani Sabounjian UB" -> "Ani Sabounjian"
            mapped['name'] = re.sub(
                r'\s+(?:IES\s+)?(?:V|UB|Be|Fl|Fx|FX)(?:,(?:V|UB|Be|Fl|Fx|FX))*\s*$',
                '', str(mapped['name'])
            ).strip()

            # Clean prefixes like "Session: P7" -> "P7", "Level: XB" -> "XB"
            session = self._clean_prefix(str(mapped.get('session', '')), 'Session')
            level = self._clean_prefix(str(mapped.get('level', '')), 'Level')
            division = self._clean_prefix(str(mapped.get('division', '')), 'Division')

            athlete = {
                'name': str(mapped.get('name', '')),
                'gym': str(mapped.get('gym', '')),
                'session': session,
                'level': level,
                'division': division,
                'vault': self._parse_score(mapped.get('vault')),
                'bars': self._parse_score(mapped.get('bars')),
                'beam': self._parse_score(mapped.get('beam')),
                'floor': self._parse_score(mapped.get('floor')),
                'aa': self._parse_score(mapped.get('aa')),
                'rank': str(mapped.get('rank', '')),
                'num': str(mapped.get('num', '')),
            }

            # Extract ScoreCat-style per-event ranks if present
            for rank_key, rank_field in [
                ('vtRank', 'vault_rank'), ('ubRank', 'bars_rank'),
                ('bbRank', 'beam_rank'), ('fxRank', 'floor_rank'),
                ('aaPlace', 'aa_rank'), ('aaRank', 'aa_rank'),
            ]:
                if rank_key in row:
                    athlete[rank_field] = self._parse_rank(row[rank_key])

            athletes.append(athlete)

        return athletes

    def _parse_tsv_content(self, content: str) -> list[dict]:
        """Parse TSV content with a header row."""
        lines = content.split('\n')
        if len(lines) < 2:
            return []

        # Parse header to figure out column mapping
        header = lines[0].strip().split('\t')
        col_map = {}
        for i, col in enumerate(header):
            canonical = COLUMN_ALIASES.get(col.lower().strip().replace(' ', '').replace('_', ''))
            if canonical:
                col_map[canonical] = i

        athletes = []
        for line in lines[1:]:
            parts = line.strip().split('\t')
            if not parts or not parts[0]:
                continue

            def get_col(name: str, default=''):
                idx = col_map.get(name)
                if idx is not None and idx < len(parts):
                    return parts[idx].strip()
                return default

            name = get_col('name')
            if not name:
                continue

            athletes.append({
                'name': name,
                'gym': get_col('gym'),
                'session': get_col('session'),
                'level': get_col('level'),
                'division': get_col('division'),
                'vault': self._parse_score(get_col('vault')),
                'bars': self._parse_score(get_col('bars')),
                'beam': self._parse_score(get_col('beam')),
                'floor': self._parse_score(get_col('floor')),
                'aa': self._parse_score(get_col('aa')),
                'rank': get_col('rank'),
                'num': get_col('num'),
            })

        return athletes

    @staticmethod
    def _clean_prefix(raw: str, prefix: str) -> str:
        """Strip common prefixes like 'Session: P7' -> 'P7'."""
        raw = raw.strip()
        raw = re.sub(rf'^{prefix}:\s*', '', raw, flags=re.IGNORECASE)
        return raw.strip()

    @staticmethod
    def _parse_score(val):
        """Parse a score value. Returns None for empty/invalid/zero."""
        if val is None:
            return None
        s = str(val).strip()
        if not s:
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
