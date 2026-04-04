"""Gym name normalizer for gymnastics meet data.

Seven-phase normalization:
  Phase 0 — Persistent alias lookup: apply Supabase-sourced canonical aliases
  Phase 1 — Auto-normalize: title-case, collapse whitespace, group case-insensitive matches
  Phase 1.5 — Club number dedup: group by club_num, merge to most-common name
  Phase 2 — Suffix-aware merge: consolidate all variants (base + suffixed) to longest name
  Phase 2.5 — Abbreviation-initials detection: flag gyms that look like initials of another
  Phase 3 — Fuzzy duplicate detection (informational, not auto-merged)
  Phase 4 — Manual gym-map: apply user-provided alias mapping (case-insensitive keys)
"""
from __future__ import annotations

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
    # Preserve dotted acronyms like "A.C.E.S.", "G.M.S.", "N.E.T.S."
    stripped = word.rstrip('.')
    if stripped and all(c == '.' or c.isupper() for c in stripped) and any(c == '.' for c in stripped):
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


def normalize(athletes: list[dict], gym_map_path: str | None = None,
              aliases: dict[str, str] | None = None) -> dict:
    """Normalize gym names in athlete data.

    Args:
        athletes: List of athlete dicts (modified in-place).
        gym_map_path: Optional path to a JSON file mapping old names to canonical names.
        aliases: Optional dict mapping lowercase gym names to canonical names
                 (from Supabase persistent aliases).

    Returns:
        Dict with:
          normalized_athletes: the (modified) athletes list
          gym_report: {unique_gyms, auto_merged, suffix_merged, potential_duplicates,
                       alias_applied, clubnum_merged, initials_suspects}
    """
    auto_merged = {}
    suffix_merged = {}
    alias_applied = {}
    clubnum_merged = {}
    initials_suspects = []

    # ========================================
    # Phase 0: Persistent alias lookup
    # ========================================
    alias_canonical_values: set[str] = set()
    if aliases:
        # Normalize alias keys to match Phase 1: curly apostrophes → straight, hyphens → spaces
        alias_lower = {k.replace('\u2019', "'").replace('\u2018', "'").replace('-', ' ').lower().strip(): v
                       for k, v in aliases.items()}
        alias_canonical_values = set(aliases.values())
        applied = 0
        for a in athletes:
            gym = a.get('gym', '') or ''
            key = gym.replace('\u2019', "'").replace('\u2018', "'").replace('-', ' ').strip().lower()
            if key in alias_lower:
                canonical = alias_lower[key]
                if gym.strip() != canonical:
                    alias_applied[gym.strip()] = canonical
                a['gym'] = canonical
                applied += 1
        if applied:
            print(f"Phase 0: Alias lookup applied to {applied} athletes "
                  f"({len(alias_applied)} unique mappings)")

    # ========================================
    # Phase 1: Case-insensitive auto-normalize
    # ========================================
    # Group by lowercase key, pick the best title-cased canonical form
    gym_counts: dict[str, dict[str, int]] = {}  # lowercase -> {original: count}
    for a in athletes:
        gym = a.get('gym', '') or ''
        key = gym.strip().lower()
        key = key.replace('\u2019', "'").replace('\u2018', "'")  # curly → straight apostrophe
        key = key.replace('-', ' ')          # "win-win" → "win win"
        key = re.sub(r'\s+', ' ', key)
        if not key:
            continue
        if key not in gym_counts:
            gym_counts[key] = {}
        gym_counts[key][gym.strip()] = gym_counts[key].get(gym.strip(), 0) + 1

    # For each group, pick the best canonical form.
    # When multiple variants exist, prefer the one with more uppercase characters
    # (preserves brand capitalization like "KCGym", "GymQuarters") over blind title-casing.
    # Tiebreaker: longer name, then most common occurrence.
    canonical_map: dict[str, str] = {}  # any original form -> canonical
    for key, variants in gym_counts.items():
        if len(variants) == 1:
            original = next(iter(variants))
            if original in alias_canonical_values:
                canonical = original
            else:
                canonical = _title_case_gym(original)
        else:
            # Multiple variants — pick the best one:
            # 1. Most uppercase chars (preserves brand caps like "KCGym")
            # 2. Longest name (more descriptive)
            # 3. Most common occurrence
            def _variant_score(v):
                return (sum(1 for c in v if c.isupper()), len(v), variants[v])
            best = max(variants, key=_variant_score)
            if best in alias_canonical_values:
                canonical = best
            else:
                # Use the best variant as-is if it has intentional casing (mixed case);
                # only title-case if it's all-lowercase or all-uppercase
                if best.islower() or best.isupper():
                    canonical = _title_case_gym(best)
                else:
                    canonical = best  # preserve original mixed casing

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
    # Phase 1.5: Club number dedup
    # ========================================
    # Group athletes by club_num; for each club_num with multiple gym names,
    # merge all to the most-common name (length as tiebreaker).
    clubnum_groups: dict[str, dict[str, int]] = {}  # club_num -> {gym_name: count}
    for a in athletes:
        cn = (a.get('club_num') or '').strip()
        if not cn:
            continue
        gym = a.get('gym', '') or ''
        if not gym:
            continue
        if cn not in clubnum_groups:
            clubnum_groups[cn] = {}
        clubnum_groups[cn][gym] = clubnum_groups[cn].get(gym, 0) + 1

    clubnum_merge_map: dict[str, str] = {}  # old gym name -> canonical
    for cn, name_counts in clubnum_groups.items():
        if len(name_counts) <= 1:
            continue
        # Pick the most common name; break ties by longest name
        best = max(name_counts, key=lambda g: (name_counts[g], len(g)))
        for name in name_counts:
            if name != best:
                clubnum_merge_map[name] = best
                clubnum_merged[name] = best

    if clubnum_merge_map:
        for a in athletes:
            gym = a.get('gym', '')
            if gym in clubnum_merge_map:
                a['gym'] = clubnum_merge_map[gym]
        if clubnum_merged:
            print(f"Phase 1.5: Club number dedup merged {len(clubnum_merged)} gym name variants")

    # ========================================
    # Phase 2: Suffix-aware merge (consolidated)
    # ========================================
    # After case normalization, merge all variants sharing a base name.
    # The bare base is included as a merge candidate alongside suffixed forms.
    # ALWAYS prefer the longest (fullest) name.
    unique_after_case = set(a.get('gym', '') for a in athletes if a.get('gym'))

    # Count athletes per gym for tiebreaking
    gym_athlete_counts: dict[str, int] = {}
    for a in athletes:
        g = a.get('gym', '')
        if g:
            gym_athlete_counts[g] = gym_athlete_counts.get(g, 0) + 1

    # Build base_name -> list of (full_name) for all suffixed variants
    base_to_suffixed: dict[str, list[str]] = {}
    for gym in unique_after_case:
        words = gym.split()
        if len(words) >= 2 and words[-1].lower() in _MERGE_SUFFIXES:
            base = ' '.join(words[:-1])
            if base not in base_to_suffixed:
                base_to_suffixed[base] = []
            base_to_suffixed[base].append(gym)

    # For each base that has suffixed variant(s), merge all forms to the longest name
    suffix_merge_map: dict[str, str] = {}  # any form -> canonical
    for base, suffixed_forms in base_to_suffixed.items():
        # Include base as a candidate if it exists as a standalone gym
        all_candidates = list(suffixed_forms)
        if base in unique_after_case:
            all_candidates.append(base)

        if len(all_candidates) <= 1:
            continue

        # Pick the longest name; break ties by athlete count
        best = max(all_candidates, key=lambda g: (len(g), gym_athlete_counts.get(g, 0)))
        for form in all_candidates:
            if form != best:
                suffix_merge_map[form] = best
                suffix_merged[form] = best

    # Apply suffix merges to athletes
    if suffix_merge_map:
        for a in athletes:
            gym = a.get('gym', '')
            if gym in suffix_merge_map:
                a['gym'] = suffix_merge_map[gym]

    # ========================================
    # Phase 2.5: Abbreviation-initials detection
    # ========================================
    # Detect gyms whose name looks like initials of another gym's name.
    # Uses strip_count (0, 1, or 2 suffix words) to test if initials match.
    unique_after_suffix = sorted(set(a.get('gym', '') for a in athletes if a.get('gym')))

    for gym in unique_after_suffix:
        words_upper = gym.upper().split()
        # Only consider short names that look like initials (2-5 chars, all uppercase)
        if not (gym.isupper() and 2 <= len(gym.replace(' ', '')) <= 5):
            continue
        initials_str = gym.replace(' ', '').upper()

        for candidate in unique_after_suffix:
            if candidate == gym:
                continue
            cand_words = candidate.split()
            if len(cand_words) < 2:
                continue
            # Try strip_count 0, 1, or 2 suffix words
            for strip_count in range(3):
                check_words = cand_words[:len(cand_words) - strip_count] if strip_count else cand_words
                if len(check_words) < 2:
                    continue
                cand_initials = ''.join(w[0].upper() for w in check_words if w)
                if cand_initials == initials_str:
                    initials_suspects.append((gym, candidate, strip_count))
                    break  # found a match, no need to try more strip counts

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
    gym_map_lower: dict[str, str] = {}
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

    # Suppress potential duplicates that are already handled by gym map
    if gym_map_lower:
        mapped_keys = set(gym_map_lower.keys())
        mapped_values = set(v.lower().strip() for v in gym_map_lower.values())
        potential_duplicates = [
            (g1, g2, ratio) for g1, g2, ratio in potential_duplicates
            if g1.lower().strip() not in mapped_keys
            and g2.lower().strip() not in mapped_keys
            and not (g1.lower().strip() in mapped_values and g2.lower().strip() in mapped_values)
        ]

    # Build athlete counts per gym for agent context during dedup review
    gym_athlete_counts: dict[str, int] = {}
    for a in athletes:
        g = a.get('gym', '')
        if g:
            gym_athlete_counts[g] = gym_athlete_counts.get(g, 0) + 1

    return {
        'normalized_athletes': athletes,
        'gym_report': {
            'unique_gyms': unique_gyms,
            'auto_merged': auto_merged,
            'suffix_merged': suffix_merged,
            'potential_duplicates': potential_duplicates,
            'alias_applied': alias_applied,
            'clubnum_merged': clubnum_merged,
            'initials_suspects': initials_suspects,
            'gym_athlete_counts': gym_athlete_counts,
        },
    }


def _print_section(title: str, items: list[str], max_show: int = 15) -> None:
    """Print a labeled section with optional truncation."""
    if not items:
        return
    if len(items) > max_show:
        print(f"{title} (showing {max_show} of {len(items)}):")
    else:
        print(f"{title}:")
    print('\n'.join(items[:max_show]))
    if len(items) > max_show:
        print(f"  ... and {len(items) - max_show} more")


def print_gym_report(report: dict) -> None:
    """Print a human-readable gym normalization report to stdout."""
    gyms = report['unique_gyms']
    merged = report['auto_merged']
    suffix = report.get('suffix_merged', {})
    dupes = report['potential_duplicates']
    alias = report.get('alias_applied', {})
    clubnum = report.get('clubnum_merged', {})
    initials = report.get('initials_suspects', [])

    total_merged = len(merged) + len(suffix) + len(alias) + len(clubnum)
    print(f"\nGym normalization: {len(gyms)} unique gyms, "
          f"{total_merged} auto-merged ({len(alias)} alias, {len(merged)} case, "
          f"{len(clubnum)} clubnum, {len(suffix)} suffix), "
          f"{len(dupes)} potential duplicates to review")

    _print_section("Alias-applied",
                   [f'  "{k}" -> "{v}"' for k, v in sorted(alias.items())])

    _print_section("Case-merged",
                   [f'  "{k}" -> "{v}"' for k, v in sorted(merged.items())])

    _print_section("Club-num merged",
                   [f'  "{k}" -> "{v}"' for k, v in sorted(clubnum.items())])

    _print_section("Suffix-merged",
                   [f'  "{k}" -> "{v}"' for k, v in sorted(suffix.items())])

    if initials:
        print(f"Initials suspects ({len(initials)}):")
        for short, full, sc in initials[:15]:
            print(f'  "{short}" might be initials of "{full}" (strip_count={sc})')
        if len(initials) > 15:
            print(f"  ... and {len(initials) - 15} more")

    if dupes:
        print(f"Potential duplicates (>{80}% similar):")
        for g1, g2, ratio in dupes[:15]:
            print(f'  "{g1}" / "{g2}" ({int(ratio*100)}% similar)')
        if len(dupes) > 15:
            print(f"  ... and {len(dupes) - 15} more")

    # Print full gym list with athlete counts for agent dedup review
    counts = report.get('gym_athlete_counts', {})
    if counts and (dupes or initials):
        _print_section('All gyms with athlete counts — review for possible duplicates',
                       [f'{g} ({counts.get(g, 0)} athletes)' for g in gyms],
                       max_show=30)
