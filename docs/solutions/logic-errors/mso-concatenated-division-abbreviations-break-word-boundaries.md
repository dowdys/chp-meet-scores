---
title: MSO concatenated division abbreviations break regex word boundaries
category: logic-errors
date: 2026-03-19
component: python/core/division_detector.py
severity: high
tags: [mso, division-ordering, regex, data-source-quirk]
---

## Problem

Division ordering was scrambled for meets imported from MeetScoresOnline (MSO). Divisions like "CHA", "JRA1", "SRB2" all scored 8000 (unknown) and sorted after all recognized age groups, producing jumbled athlete ordering on the shirt.

## Root Cause

MSO uses **concatenated division abbreviations without spaces**: "CHA" instead of "CH A", "JRA1" instead of "JR A1", "SRB2" instead of "SR B2".

The division detector's tier patterns used regex word boundaries (`\b`) to match prefixes:

```python
tier_patterns = [
    (r'^(?:CHILD|CH)\b',  2000),
    (r'^(?:JUNIOR|JR)\.?\b', 5000),
    (r'^(?:SENIOR|SR)\.?\b', 6000),
]
```

The `\b` anchor asserts a boundary between a word character and a non-word character. In "CHA", the character after "CH" is 'A' — a word character. So `\b` fails to match, and the entire tier detection loop produces `base = None`, falling through to the unknown score (8000).

This only affects the **concatenated forms**. Spaced forms like "CH A", "JR A1" work fine because the space is a non-word character that satisfies `\b`.

## Solution

Added a fallback regex after the `\b`-anchored tier loop that catches concatenated forms:

```python
if base is None:
    # Fallback for MSO-style concatenated abbreviations (CHA, JRA1, SRB2)
    concat = re.match(r'^(CH|JR|SR|YTH)([A-Z]\d*|\d+)$', upper)
    if concat:
        prefix = concat.group(1)
        tier_map = {'CH': 2000, 'YTH': 3000, 'JR': 5000, 'SR': 6000}
        base = tier_map.get(prefix, 8000)
        remainder = concat.group(2)
```

This produces identical scores for both forms: "CHA" and "CH A" both score 2010, "JRA1" and "JR A1" both score 5011.

## Prevention

When writing regex patterns to match prefixes in gymnastics division names:

1. **Never assume spaces between tier prefix and group letter.** MSO concatenates them.
2. **Test with both "JR A1" and "JRA1" forms** — they must produce the same sort order.
3. **Be cautious with `\b` word boundaries** — they fail when the next character after the prefix is alphanumeric, which is exactly the case for concatenated abbreviations.
4. The canonical MSO abbreviation patterns are: CH[A-Z], JR[A-Z][0-9]?, SR[A-Z][0-9]?, YTH[A-Z].

## Related

- `docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md` — another division/ordering data integrity issue
- `skills/database_building.md` line 58 — documents MSO division naming conventions
