"""Adapter for parsing MeetScoresOnline PDF files (e.g. Alabama)."""

import fitz
from .base import BaseAdapter


class PdfAdapter(BaseAdapter):
    """Parse gymnastics meet results from MeetScoresOnline PDF exports."""

    # Column x-position ranges for scores
    VAULT_X = (240, 290)
    BARS_X = (318, 368)
    BEAM_X = (395, 445)
    FLOOR_X = (472, 522)
    AA_X = (540, 600)
    NAME_X = (85, 240)
    RANK_X = (10, 50)
    NUM_X = (50, 85)

    def parse(self, data_path: str) -> list[dict]:
        """Parse a PDF and return list of athlete dicts."""
        doc = fitz.open(data_path)
        all_athletes = []

        for page_num in range(doc.page_count):
            athletes = self._parse_individual_page(page_num, doc)
            if athletes:
                all_athletes.extend(athletes)

        doc.close()
        return all_athletes

    def _parse_individual_page(self, page_num: int, doc) -> list[dict]:
        """Parse a single individual results page and return list of athlete dicts."""
        page = doc[page_num]
        blocks = page.get_text("dict")

        lines_data = []
        for block in blocks["blocks"]:
            if "lines" in block:
                for line in block["lines"]:
                    spans_text = " ".join(span["text"] for span in line["spans"])
                    y = round(line["bbox"][1], 1)
                    x = round(line["bbox"][0], 1)
                    text = spans_text.strip()
                    if text:
                        lines_data.append((y, x, text))

        lines_data.sort()

        # Skip team pages
        if self._is_team_page(lines_data):
            return []

        # Get header info
        session, level, division = self._extract_header_info(lines_data)
        if not session or not level or not division:
            return []

        # Filter to data area only (below header, above footer)
        data_lines = [(y, x, text) for y, x, text in lines_data
                      if 130 < y < 750]

        if not data_lines:
            return []

        # Group all data lines by y-position (cluster nearby y values)
        y_clusters = []
        current_cluster = []
        last_y = None

        for y, x, text in data_lines:
            if last_y is not None and abs(y - last_y) > 5:
                if current_cluster:
                    y_clusters.append(current_cluster)
                current_cluster = []
            current_cluster.append((y, x, text))
            last_y = y
        if current_cluster:
            y_clusters.append(current_cluster)

        # Process clusters to extract athletes
        athletes = []
        i = 0
        while i < len(y_clusters):
            cluster = y_clusters[i]
            avg_y = sum(item[0] for item in cluster) / len(cluster)

            # Check if this cluster has scores (indicating a name/score row)
            has_scores = False
            name = None
            vault_score = bars_score = beam_score = floor_score = aa_score = None
            rank = None
            num = None

            for y, x, text in cluster:
                if self.NAME_X[0] <= x <= self.NAME_X[1] and not self._is_score(text):
                    name = text
                if self.VAULT_X[0] <= x <= self.VAULT_X[1] and self._is_score(text):
                    vault_score = float(text)
                    has_scores = True
                if self.BARS_X[0] <= x <= self.BARS_X[1] and self._is_score(text):
                    bars_score = float(text)
                if self.BEAM_X[0] <= x <= self.BEAM_X[1] and self._is_score(text):
                    beam_score = float(text)
                if self.FLOOR_X[0] <= x <= self.FLOOR_X[1] and self._is_score(text):
                    floor_score = float(text)
                if self.AA_X[0] <= x <= self.AA_X[1] and self._is_score(text):
                    aa_score = float(text)
                if self.RANK_X[0] <= x <= self.RANK_X[1]:
                    rank = text
                if self.NUM_X[0] <= x <= self.NUM_X[1]:
                    num = text

            if has_scores and name:
                # Look at next cluster for rank/num if not found
                if not rank and i + 1 < len(y_clusters):
                    next_cluster = y_clusters[i + 1]
                    next_avg_y = sum(item[0] for item in next_cluster) / len(next_cluster)
                    if next_avg_y - avg_y < 5:  # Very close = rank/num row
                        for y, x, text in next_cluster:
                            if self.RANK_X[0] <= x <= self.RANK_X[1]:
                                rank = text
                            if self.NUM_X[0] <= x <= self.NUM_X[1]:
                                num = text
                        i += 1

                # Look for gym name in next cluster
                gym = None
                if i + 1 < len(y_clusters):
                    next_cluster = y_clusters[i + 1]
                    for y, x, text in next_cluster:
                        if self.NAME_X[0] <= x <= self.NAME_X[1] and not self._is_score(text):
                            gym = text
                    if gym:
                        i += 1  # Skip the gym row

                athletes.append({
                    'name': name,
                    'gym': gym or 'Unknown',
                    'session': session,
                    'level': level,
                    'division': division,
                    'vault': vault_score,
                    'bars': bars_score,
                    'beam': beam_score,
                    'floor': floor_score,
                    'aa': aa_score,
                    'rank': rank,
                    'num': num,
                })

            i += 1

        return athletes

    @staticmethod
    def _extract_header_info(lines_data: list) -> tuple:
        """Extract session, level, division from page header."""
        session = level = division = None
        for y, x, text in lines_data:
            if y > 100:
                break
            if text.startswith("Session:"):
                session = text.replace("Session:", "").strip()
            elif text.startswith("Level:"):
                level = text.replace("Level:", "").strip()
            elif text.startswith("Division:"):
                division = text.replace("Division:", "").strip()
        return session, level, division

    @staticmethod
    def _is_score(text: str) -> bool:
        """Check if text looks like a gymnastics score (e.g., 9.450 or 37.825)."""
        try:
            val = float(text)
            return 5.0 <= val <= 40.0
        except ValueError:
            return False

    @staticmethod
    def _is_team_page(lines_data: list) -> bool:
        """Check if this is a team results page (not individual)."""
        for y, x, text in lines_data:
            if "Meet Results - Team" in text:
                return True
            if y > 150:
                break
        return False
