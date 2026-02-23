# Detail: PDF Layout Calibration

## Standard MSO PDF Column Positions
| Column | X Min | X Max | Notes |
|--------|-------|-------|-------|
| Rank | 10 | 50 | Integer, may have "T" suffix |
| Number | 50 | 85 | Athlete competition number |
| Name/Gym | 85 | 240 | Name on score row, gym on next y-cluster |
| Vault | 240 | 290 | Score 5.0-10.0 |
| Bars | 318 | 368 | Score 5.0-10.0 |
| Beam | 395 | 445 | Score 5.0-10.0 |
| Floor | 472 | 522 | Score 5.0-10.0 |
| AA | 540 | 600 | Score 20.0-40.0 |

## Detecting Layout Shifts
If parsed data has many nulls or misaligned columns, the PDF layout may differ from standard. To verify:
1. Extract raw text+coordinates from page 1 using PyMuPDF: `page.get_text("dict")`
2. Look for the column header row (y < 130) — it contains "Vault", "Bars", "Beam", "Floor", "AA"
3. Compare header x-positions against the standard ranges above
4. If headers are shifted, adjust all column ranges by the same offset

## Multi-Line Name Handling
Long athlete names (e.g., "Madison Weathersbee") may wrap to a second PDF line. The parser groups text by y-position clusters (items within 5 y-units are in the same cluster). Multi-line names produce:
- First line: partial name at NAME_X with scores at score columns
- Second line: rest of name at NAME_X, parsed as a separate cluster

**Detection**: The second line cluster has text at NAME_X but no scores. The parser treats the next cluster (with NAME_X text and no scores) as the gym name.

**Result**: The second part of the name becomes the "gym" field. Caught by the split name detection quality check (gyms with count=1).

## Team Results Page Detection
Pages containing "Meet Results - Team" in the header area (y < 150) are team aggregate results, not individual. The parser skips these automatically. Team pages typically appear at the beginning of the PDF (first ~11 pages for a large meet).
