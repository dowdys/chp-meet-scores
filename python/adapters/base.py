"""Abstract base adapter for parsing meet data from various sources."""

from abc import ABC, abstractmethod


class BaseAdapter(ABC):
    @abstractmethod
    def parse(self, data_path: str) -> list[dict]:
        """Parse meet data and return list of athlete dicts.

        Each dict must have keys:
            name, gym, session, level, division,
            vault, bars, beam, floor, aa, rank, num

        ScoreCat adapter also includes per-event ranks:
            vault_rank, bars_rank, beam_rank, floor_rank, aa_rank
        """
        pass
