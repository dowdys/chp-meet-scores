"""Gym name normalizer for gymnastics meet data.

Three-phase normalization:
  Phase 1 — Auto-normalize: title-case, collapse whitespace, group case-insensitive matches
  Phase 2 — Suffix-aware merge: "All Pro" + "All Pro Gymnastics" → "All Pro Gymnastics"
  Phase 3 — Fuzzy duplicate detection (informational, not auto-merged)
  Phase 4 — Manual gym-map: apply user-provided alias mapping (case-insensitive keys)
"""

import json
import re
from difflib import SequenceMatcher


# Suffixes that indicate "this is part of the gym name" — used for merge logic
_MERGE_SUFFIXES = {
    'gymnastics', 'gym', 'gymnastic', 'academy', 'athletics',
    'center', 'centre', 'club', 'training', 'tumbling', 'cheer',
}


def _title_case_word(word: str) -> str:
    """Title-case a single word, handling hyphens and preserving acronyms."""
    # Handle hyphenated words: "Win-Win" → capitalize each part
    if '-' in word:
        parts = word.split('-')
        return '-'.join(_title_case_word(p) for p in parts)
    # Preserve all-caps words that look like acronyms (2-4 uppercase letters)
    if word.isupper() and 2 <= len(word) <= 4:
        return word
    return word.capitalize()


def _title_case_gym(name: str) -> str:
    """Title-case a gym name, preserving acronyms and hyphenation."""
    # Normalize internal whitespace
    name = re.sub(r'\s+', ' ', name.strip())
    if not name:
        return name

    words = name.split(' ')
    return ' '.join(_title_case_word(w) for w in words)


def normalize(athletes: list[dict], gym_map_path: str | None = None) -> dict:
    """Normalize gym names in athlete data.

    Args:
        athletes: List of athlete dicts (modified in-place).
        gym_map_path: Optional path to a JSON file mapping old names to canonical names.

    Returns:
        Dict with:
          normalized_athletes: the (modified) athletes list
          gym_report: {unique_gyms, auto_merged, suffix_merged, potential_duplicates}
    """
    auto_merged = {}
    suffix_merged = {}

    # ========================================
    # Phase 1: Case-insensitive auto-normalize
    # ========================================
    # Group by lowercase key, pick the best title-cased canonical form
    gym_counts: dict[str, dict[str, int]] = {}  # lowercase -> {original: count}
    for a in athletes:
        gym = a.get('gym', '') or ''
        key = gym.strip().lower()
        key = key.replace('-', ' ')          # "win-win" → "win win"
        key = re.sub(r'\s+', ' ', key)
        if not key:
            continue
        if key not in gym_counts:
            gym_counts[key] = {}
        gym_counts[key][gym.strip()] = gym_counts[key].get(gym.strip(), 0) + 1

    # For each group, pick the best canonical form
    canonical_map: dict[str, str] = {}  # any original form -> canonical
    for key, variants in gym_counts.items():
        if len(variants) == 1:
            # Only one variant — title-case from the ORIGINAL form (preserves acronyms)
            original = next(iter(variants))
            canonical = _title_case_gym(original)
        else:
            # Multiple variants — title-case the most common one
            most_common = max(variants, key=lambda v: variants[v])
            canonical = _title_case_gym(most_common)

        for variant in variants:
            if variant != canonical:
                auto_merged[variant] = canonical
            canonical_map[variant] = canonical

    # Apply case normalization to athletes
    for a in athletes:
        gym = a.get('gym', '') or ''
        stripped = gym.strip()
        if stripped in canonical_map:
            a['gym'] = canonical_map[stripped]

    # Remove self-mappings from the report
    auto_merged = {k: v for k, v in auto_merged.items() if k != v}

    # ========================================
    # Phase 2: Suffix-aware merge
    # ========================================
    # After case normalization, merge "X" into "X Gymnastics" when the suffix
    # is a known gym-related word. The full name (with suffix) is the canonical form.
    unique_after_case = set(a.get('gym', '') for a in athletes if a.get('gym'))

    # Build base_name -> list of (full_name, suffix) for all suffixed variants
    base_to_suffixed: dict[str, list[str]] = {}
    for gym in unique_after_case:
        words = gym.split()
        if len(words) >= 2 and words[-1].lower() in _MERGE_SUFFIXES:
            base = ' '.join(words[:-1])
            if base not in base_to_suffixed:
                base_to_suffixed[base] = []
            base_to_suffixed[base].append(gym)

    # For each base that exists as a standalone gym AND has suffixed variant(s),
    # merge the standalone into the suffixed form
    suffix_merge_map: dict[str, str] = {}  # standalone -> canonical suffixed
    for base, suffixed_forms in base_to_suffixed.items():
        if base not in unique_after_case:
            continue  # base doesn't exist as standalone, nothing to merge

        if len(suffixed_forms) == 1:
            # Clear case: merge base into the one suffixed form
            suffix_merge_map[base] = suffixed_forms[0]
            suffix_merged[base] = suffixed_forms[0]
        else:
            # Multiple suffixed forms (e.g., "X Gym" and "X Gymnastics")
            # Pick the most common one by athlete count
            gym_athlete_counts = {}
            for a in athletes:
                g = a.get('gym', '')
                if g in suffixed_forms:
                    gym_athlete_counts[g] = gym_athlete_counts.get(g, 0) + 1
            if gym_athlete_counts:
                best = max(gym_athlete_counts, key=lambda g: gym_athlete_counts[g])
                suffix_merge_map[base] = best
                suffix_merged[base] = best
                # Also merge the less common suffixed forms into the best one
                for sf in suffixed_forms:
                    if sf != best:
                        suffix_merge_map[sf] = best
                        suffix_merged[sf] = best

    # Apply suffix merges to athletes
    if suffix_merge_map:
        for a in athletes:
            gym = a.get('gym', '')
            if gym in suffix_merge_map:
                a['gym'] = suffix_merge_map[gym]

    # ========================================
    # Phase 3: Fuzzy duplicate detection
    # ========================================
    unique_gyms = sorted(set(a.get('gym', '') for a in athletes if a.get('gym')))
    potential_duplicates = []

    # Compare all pairs (feasible for < 500 gyms, typically < 100)
    if len(unique_gyms) <= 500:
        for i in range(len(unique_gyms)):
            for j in range(i + 1, len(unique_gyms)):
                g1, g2 = unique_gyms[i], unique_gyms[j]
                ratio = SequenceMatcher(None, g1.lower(), g2.lower()).ratio()
                if ratio > 0.80 and g1 != g2:
                    potential_duplicates.append((g1, g2, round(ratio, 2)))

    # ========================================
    # Phase 4: Manual gym-map (case-insensitive)
    # ========================================
    if gym_map_path:
        try:
            with open(gym_map_path, 'r') as f:
                gym_map = json.load(f)

            # Build case-insensitive lookup so the map works regardless of
            # what auto-normalize did to the casing
            gym_map_lower = {k.lower().strip(): v for k, v in gym_map.items()}

            applied = 0
            for a in athletes:
                gym = a.get('gym', '')
                key = gym.lower().strip()
                if key in gym_map_lower:
                    a['gym'] = gym_map_lower[key]
                    applied += 1

            # Refresh unique gyms after manual mapping
            unique_gyms = sorted(set(a.get('gym', '') for a in athletes if a.get('gym')))
            print(f"Gym map applied: {applied} athletes updated from {len(gym_map)} mappings")
        except FileNotFoundError:
            print(f"Warning: Gym map file not found: {gym_map_path}")
        except json.JSONDecodeError as e:
            print(f"Warning: Invalid JSON in gym map file: {e}")

    return {
        'normalized_athletes': athletes,
        'gym_report': {
            'unique_gyms': unique_gyms,
            'auto_merged': auto_merged,
            'suffix_merged': suffix_merged,
            'potential_duplicates': potential_duplicates,
        },
    }


def print_gym_report(report: dict) -> None:
    """Print a human-readable gym normalization report to stdout."""
    gyms = report['unique_gyms']
    merged = report['auto_merged']
    suffix = report.get('suffix_merged', {})
    dupes = report['potential_duplicates']

    total_merged = len(merged) + len(suffix)
    print(f"\nGym normalization: {len(gyms)} unique gyms, "
          f"{total_merged} auto-merged ({len(merged)} case, {len(suffix)} suffix), "
          f"{len(dupes)} potential duplicates to review")

    if merged:
        merge_lines = [f'  "{k}" -> "{v}"' for k, v in sorted(merged.items())]
        if len(merge_lines) > 15:
            print(f"Case-merged (showing 15 of {len(merge_lines)}):")
            print('\n'.join(merge_lines[:15]))
        else:
            print(f"Case-merged:")
            print('\n'.join(merge_lines))

    if suffix:
        suffix_lines = [f'  "{k}" -> "{v}"' for k, v in sorted(suffix.items())]
        if len(suffix_lines) > 15:
            print(f"Suffix-merged (showing 15 of {len(suffix_lines)}):")
            print('\n'.join(suffix_lines[:15]))
        else:
            print(f"Suffix-merged:")
            print('\n'.join(suffix_lines))

    if dupes:
        print(f"Potential duplicates (>{80}% similar):")
        for g1, g2, ratio in dupes[:15]:
            print(f'  "{g1}" / "{g2}" ({int(ratio*100)}% similar)')
        if len(dupes) > 15:
            print(f"  ... and {len(dupes) - 15} more")
