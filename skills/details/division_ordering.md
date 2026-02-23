# Detail: Division Ordering Maps

Division ordering for the winners CSV sort: youngest age group first, oldest last. Used to sort the CSV by division within each level.

## Iowa
```
CH A=1, CH B=2, CH C=3, CH D=4,
Jr A=6, Jr B=7, Jr C=8, Jr D=9,
Sr A=11, Sr B=12, Sr C=13, Sr D=14
```

## Colorado
```
Child=1, Youth=2,
Jr. A=3, Jr. B=4, Jr. C=5, Junior=6,
Sr. A=7, Sr. B=8, Senior=9
```

## Alabama
Uses letters: `A=1, B=2, C=3, D=4, E=5, ...` (alphabetical = youngest to oldest)

## Utah
```
CH A=1, CH B=2, CH C=3, CH D=4,
JR A=5, JR B=6, JR C=7, JR D=8,
SR A=9, SR B=10, SR C=11, SR D=12,
Senior=13
```

## Determining Order for a New State
1. Check the meet program or website for division definitions (age ranges)
2. Map youngest age range to lowest sort number
3. If no age info is available, assume alphabetical within each age group prefix (CH/Jr/Sr/Child/Youth/Junior/Senior)
4. Add the new mapping to this file for future reference
