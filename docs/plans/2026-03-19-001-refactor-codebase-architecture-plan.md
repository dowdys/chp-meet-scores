---
title: "Codebase Architecture Refactor"
type: refactor
status: active
date: 2026-03-19
---

# Codebase Architecture Refactor

## Overview

Comprehensive refactoring of the CHP Meet Scores codebase to improve modularity, fix publishing bugs, harden security, and improve performance. The codebase has grown to ~16.5k lines with several god objects, heavy coupling, and accumulated technical debt. This plan addresses findings from a 7-agent code review covering architecture, TypeScript quality, Python quality, security, performance, code simplicity, and publishing pipeline correctness.

## Problem Statement

Three structural issues dominate:

1. **`pdf_generator.py` is a god object** (1,486 lines) — 5 modules import from it (including private `_underscore` functions). It simultaneously serves as a layout constants file, data query engine, layout algorithm library, PDF renderer, gym highlights generator, and name cleaning utility.

2. **Parameter explosion** — The same ~18 layout parameters are copy-pasted as keyword arguments across 8+ call sites in `process_meet.py`. `generate_order_forms_pdf` takes 23 kwargs. Adding a new parameter means editing 10+ locations.

3. **`agent-loop.ts` is a monolith** (1,640 lines) — Tool schema definitions (340 lines of static data), agent orchestration, context-bound tool implementations, and process logging all in one file.

Additionally: publishing bugs cause output format inconsistency, security gaps exist in shell commands and file operations, and performance is degraded by redundant database queries and file I/O.

## Institutional Learnings (from docs/solutions/)

These documented lessons MUST be respected throughout:

- **Sticky params bug** (`docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md`): Destructive filters (`exclude_levels`, `level_groups`, `page_size`) must NEVER be persisted in layout config. Only appearance-affecting params go in the LayoutParams dataclass.
- **PyMuPDF font loss** (`docs/solutions/runtime-errors/pymupdf-insert-text-font-loss-after-show-pdf-page.md`): After `page.show_pdf_page()`, `insert_text()` with base14 font names silently fails. Must use `TextWriter` + explicit `fitz.Font()` objects. Internal names: `tibo` (Times Bold), `tiro` (Times Roman).
- **PyMuPDF image flip** (`docs/solutions/runtime-errors/pymupdf-insert-image-ignores-idml-flip-transform.md`): Negative-scale transforms require explicit `rotate=180` parameter.

## Spec-Flow Analysis Gaps (addressed below)

The following gaps were identified by spec-flow analysis and incorporated into the phases:

1. **Phase 2→3 double migration risk**: Define `LayoutParams` and `ShirtData` in `models.py` from the start, not in `pdf_generator.py`. This way Phase 3 just moves the functions, not the types.
2. **ICML removal is definitive**: Remove in Phase 1. One fewer consumer in Phases 2 and 3.
3. **Sticky params enforcement**: `LayoutParams` gets a `STICKY_FIELDS` class variable and `to_sticky_dict()` method. Structural enforcement, not just documentation.
4. **ShirtData cache lives in the call chain**: Compute once in `process_meet.py`, pass to all generators. No module-level cache (avoids invalidation complexity with letter vs legal sizes).
5. **Font loss in gym highlights overlay**: `generate_gym_highlights_from_pdf` uses `insert_text` after `show_pdf_page` — needs TextWriter fix. Added to Phase 1.
6. **Order form optimization**: Consolidated into Phase 6 only (was duplicated in Phase 4/6).
7. **PyInstaller verification**: Explicit procedure added — build binary, run against 3 reference meets.
8. **Phase 0 safety net**: Add golden-file baselines for all outputs BEFORE any refactoring begins.
9. **Chrome path detection**: `chrome-controller.ts:58` uses shell logic (`which ... || ...`) that can't be directly converted to `execFileSync`. Needs try/catch approach instead.

## Proposed Solution

Eight phases (Phase 0 added for safety net), ordered by dependency and risk. Each phase is independently testable — run the pipeline after each one and compare outputs.

---

## Phase 0: Golden-File Baseline (Safety Net)

**Goal:** Capture current output as baselines BEFORE any changes, so every subsequent phase can be verified.
**Effort:** Small
**Risk:** None (read-only)

Generate all outputs for a reference meet and store them:

- [ ] Pick a reference meet (Iowa/ScoreCat or existing test data)
- [ ] Run full pipeline — generate all 7 output files
- [ ] Store copies as `tests/reference_data/baseline_*` (PDF, IDML, order forms, gym highlights, summary, winners)
- [ ] Render each PDF page as 200 DPI PNG for visual diff capability
- [ ] Add a simple `compare_outputs.py` script that:
  - Compares text-based outputs byte-for-byte
  - For PDFs: extracts text content and compares (pixel diff is optional)
  - Reports any differences

After every subsequent phase, run the comparison to catch regressions.

---

## Phase 1: Quick Wins & Safety Net

**Goal:** Low-risk fixes that provide immediate value and make later phases safer.
**Effort:** Small-Medium
**Risk:** Low

### 1a. SQLite Indexes

Add covering indexes to eliminate full table scans during winner determination.

```python
# python/core/db_builder.py — add after table creation
cur.execute('CREATE INDEX IF NOT EXISTS idx_results_meet_sld ON results(meet_name, session, level, division)')
cur.execute('CREATE INDEX IF NOT EXISTS idx_winners_meet_event_level ON winners(meet_name, event, level)')
cur.execute('CREATE INDEX IF NOT EXISTS idx_winners_meet_gym ON winners(meet_name, gym)')
```

- [ ] Add 3 CREATE INDEX statements to `db_builder.py`
- [ ] Verify pipeline still works with existing databases

### 1b. Context Managers

Replace manual `conn.close()` / `doc.close()` with context managers across ~37 locations.

```python
# Before (leaks on exception):
conn = sqlite3.connect(db_path)
cur = conn.cursor()
# ... operations ...
conn.close()

# After (always closes):
with sqlite3.connect(db_path) as conn:
    cur = conn.cursor()
    # ... operations ...
```

For PyMuPDF, `fitz.open()` already supports context manager protocol.

```python
# Before:
doc = fitz.open()
# ... rendering ...
doc.save(path)
doc.close()

# After:
doc = fitz.open()
try:
    # ... rendering ...
    doc.save(path)
finally:
    doc.close()
```

Note: PyMuPDF's context manager (`with fitz.open() as doc`) closes on exit, but we often need `doc.save()` before close. Use try/finally for those cases.

Files to update:
- [ ] `python/core/db_builder.py` (1 location)
- [ ] `python/core/pdf_generator.py` (~6 locations)
- [ ] `python/core/order_form_generator.py` (~2 locations)
- [ ] `python/core/output_generator.py` (~3 locations)
- [ ] `python/core/meet_summary.py` (~1 location)
- [ ] `python/core/division_detector.py` (~1 location)
- [ ] `python/core/idml_parser.py` (~3 locations)
- [ ] `python/adapters/pdf_adapter.py` (~1 location)
- [ ] `python/process_meet.py` (~1 location, the --render-pdf helper)

### 1c. Security Fixes

**Command injection — `execSync` → `execFileSync`:**

```typescript
// Before (shell interprets metacharacters):
const winPath = execSync(`wslpath -w "${meetDir}"`).toString().trim();
execSync(`explorer.exe "${winPath}"`);

// After (no shell, safe):
const winPath = execFileSync('wslpath', ['-w', meetDir], { encoding: 'utf-8' }).trim();
execFileSync('explorer.exe', [winPath]);
```

- [ ] `src/main/main.ts` — `open-output-folder` handler (~line 295)
- [ ] `src/main/main.ts` — `open-logs-folder` handler (~line 316)
- [ ] `src/main/agent-loop.ts` — `toolOpenFile` method (~line 1302)

**Path traversal — add containment checks:**

```typescript
const resolved = path.resolve(path.join(dataDir, filename));
if (!resolved.startsWith(path.resolve(dataDir))) {
  return 'Error: filename must not escape the data directory.';
}
```

- [ ] `src/main/tools/python-tools.ts` — `save_to_file` tool
- [ ] `src/main/tools/browser-tools.ts` — `chrome_save_to_file` tool
- [ ] `src/main/agent-loop.ts` — `toolSaveDraftSkill` method
- [ ] `src/main/agent-loop.ts` — `toolLoadSkill` and `toolLoadSkillDetail` (validate skill name is alphanumeric/hyphens only)

### 1d. One-Line Publishing Bug Fixes

**IDML min_font_size** — `python/core/idml_generator.py` ~line 96:
- [ ] Add `min_font_size=min_font_size` to the `precompute_shirt_data()` call

**`_level_height` divider size** — `python/core/pdf_generator.py` ~line 762:
- [ ] Add `divider_size=LEVEL_DIVIDER_SIZE` parameter to `_level_height()`
- [ ] Update `_bin_pack_levels()` to pass the custom divider size through
- [ ] Update `_fit_font_size()` call to `_level_height` to pass divider_size

**IDML copyright on legal pages** — `python/core/idml_generator.py` ~line 439:
- [ ] Change `COPYRIGHT_Y` reference to calculate from `_ph` parameter: `cr_top = (_ph or PAGE_H) - 8 - COPYRIGHT_SIZE`

**Order form IDML mimetype** — `python/core/order_form_idml.py` ~line 171:
- [ ] When writing ZIP entry named `'mimetype'`, use `compress_type=zipfile.ZIP_STORED`

### 1e. Font Loss Fix in Gym Highlights Overlay

`generate_gym_highlights_from_pdf` at `pdf_generator.py:1448` uses `page.insert_text()` with `fontname=FONT_BOLD` AFTER `page.show_pdf_page()` at line 1400. Per the documented PyMuPDF font-loss gotcha, this silently renders in the wrong font. Fix: use `fitz.TextWriter` + explicit `fitz.Font()` (same pattern already used in `order_form_generator.py:213-214`).

- [ ] Replace `insert_text()` with `TextWriter` + `fitz.Font('tibo')` in `generate_gym_highlights_from_pdf`
- [ ] Verify gym name renders in Times-Bold on highlighted pages

### 1f. Dead Code Removal & ICML Removal

- [ ] Remove `buildToolExecutors` dead stub (`agent-loop.ts:1534-1537`) and 3 call sites
- [ ] Remove wrapper functions `getProjectRoot/getOutputDir/getDataDir` in `agent-loop.ts:403-425`, use shared imports directly
- [ ] Remove duplicate wrappers in `file-tools.ts:6-12`
- [ ] Consolidate `ensureConnected()` — remove wrappers in `browser-tools.ts`, `extraction-tools.ts`, `search-tools.ts`; call `chromeController.ensureConnected()` directly
- [ ] Remove duplicate `_draw_star` in `order_form_generator.py:177`, import from `pdf_generator`
- [ ] Remove duplicate `_space_text` in `icml_generator.py:418`, import from `pdf_generator`
- [ ] Remove empty `skill-tools.ts` and its import/spread in `tools/index.ts`
- [ ] Remove redundant `await import('fs')` in `main.ts:259,287` — use top-level import
- [ ] Remove dead `customize_pdf` and `generate_both` in `order_form_idml.py:251-378`
- [ ] Remove dead `generate_back_of_shirt` in `output_generator.py:16-52`
- [ ] Deprecate/remove `generate_winners_csv` in `output_generator.py:170-234`
- [ ] Remove `icml_generator.py` entirely (ICML is deprecated — only IDML is used)
- [ ] Remove ICML-related code paths from `process_meet.py` (`--regenerate icml`)
- [ ] Remove ICML import from `process_meet.py`
- [ ] Remove duplicate `import shutil` in `process_meet.py:410`
- [ ] Move `import glob` from `process_meet.py:861` to top of file

**Estimated removal: ~756 lines**

### Phase 1 Verification
- [ ] Run `npm run build` — TypeScript compiles
- [ ] Run `npm run typecheck` — no type errors
- [ ] Run `python3 -m pytest tests/ -v` — existing tests pass
- [ ] Process a test meet end-to-end — all 7 output files generated correctly
- [ ] Compare output files byte-for-byte with pre-refactor baseline

---

## Phase 2: LayoutParams & ShirtData Dataclasses

**Goal:** Eliminate the parameter explosion and untyped return dict.
**Effort:** Medium
**Risk:** Low-Medium (mechanical transformation, but touches many files)
**Depends on:** Phase 1

### 2a. Create LayoutParams Dataclass

```python
# python/core/models.py
@dataclass
class LayoutParams:
    """Appearance-only parameters for shirt layout.

    CRITICAL: Destructive filters (exclude_levels, level_groups, page_size)
    must NEVER be included here. See docs/solutions/logic-errors/
    sticky-params-silently-exclude-athletes.md
    """
    # Spacing
    line_spacing: float | None = None       # was 'lhr' concept
    level_gap: float | None = None          # was 'lgap'
    max_fill: float | None = None           # was 'mfill'

    # Font sizes
    min_font_size: float | None = None      # was 'mfs'
    max_font_size: float | None = None      # was 'mxfs'
    title1_size: float | None = None        # was 't1l'/'t1s'
    title2_size: float | None = None        # was 't2l'/'t2s'
    header_size: float | None = None        # was 'hl'/'hs'
    divider_size: float | None = None       # was 'ds'
    oval_label_size: float | None = None
    name_size: float | None = None
    copyright_size: float | None = None

    # Content
    sport: str | None = None
    title_prefix: str | None = None
    copyright: str | None = None
    accent_color: str | None = None
    font_family: str | None = None

    # Layout constraints
    max_shirt_pages: int | None = None
    name_sort: str = 'age'
```

### 2b. Create ShirtData Dataclass

Replace the untyped dict returned by `precompute_shirt_data()`:

```python
# python/core/models.py
@dataclass
class ShirtData:
    """Precomputed layout data for shirt generation.
    Replaces the untyped dict with abbreviated keys (lhr, lgap, mfs, etc.)
    """
    # Resolved parameters (with defaults applied)
    line_height_ratio: float
    level_gap: float
    max_fill: float
    min_font_size: float
    max_font_size: float
    title1_large: float
    title1_small: float
    title2_large: float
    title2_small: float
    header_large: float
    header_small: float
    divider_size: float
    oval_label_size: float
    default_name_size: float
    copyright_size: float

    # Content
    sport: str
    title_prefix: str
    copyright_text: str
    accent_color: tuple
    font_regular: str
    font_bold: str

    # Computed layout
    page_groups: list          # bin-packed level groups
    data: dict                 # winners data by event/level
    year: str
    state: str
    meet_name: str
    font_size: float           # fitted font size
    line_height: float         # computed line height

    # Optional extras
    title_lines: tuple | None = None
    page_height: float | None = None
```

### 2c. Update precompute_shirt_data

- [ ] Change `precompute_shirt_data()` to accept `LayoutParams` and return `ShirtData`
- [ ] Update all callers:
  - `pdf_generator.py` — `generate_shirt_pdf()`, `generate_gym_highlights_pdf()`, `add_shirt_back_pages()`
  - `idml_generator.py` — `generate_shirt_idml()`
  - `order_form_generator.py` — `generate_order_forms_pdf()`
  - `meet_summary.py` — `generate_summary()`
  - `process_meet.py` — all ~8 call sites

### 2d. Cache ShirtData Across Pipeline

In `process_meet.py`, compute `ShirtData` once and pass it to all generators:

```python
# Compute once
layout = LayoutParams(line_spacing=args.line_spacing, level_gap=args.level_gap, ...)
shirt_data = precompute_shirt_data(db_path, meet_name, layout)

# Pass to all generators
generate_shirt_pdf(shirt_data, output_path)
generate_shirt_idml(shirt_data, output_path)
generate_order_forms_pdf(shirt_data, output_path)
generate_gym_highlights_pdf(shirt_data, output_path)
```

This eliminates 200-300 redundant database queries per pipeline run.

### 2e. Update Sticky Params Persistence with Structural Enforcement

Add enforcement directly to the dataclass — not just documentation:

```python
@dataclass
class LayoutParams:
    # ... fields ...

    # Structural enforcement: only these fields are persisted
    STICKY_FIELDS: ClassVar[frozenset] = frozenset({
        'line_spacing', 'level_gap', 'max_fill', 'min_font_size', 'max_font_size',
        'max_shirt_pages', 'title1_size', 'title2_size', 'header_size', 'divider_size',
        'oval_label_size', 'name_size', 'copyright_size',
        'sport', 'title_prefix', 'copyright', 'accent_color', 'font_family',
    })

    def to_sticky_dict(self) -> dict:
        """Only serialize appearance params. NEVER destructive filters."""
        return {k: v for k, v in asdict(self).items()
                if k in self.STICKY_FIELDS and v is not None}

    @classmethod
    def from_sticky_dict(cls, d: dict) -> 'LayoutParams':
        """Load only recognized sticky fields, ignoring anything else."""
        return cls(**{k: v for k, v in d.items() if k in cls.STICKY_FIELDS})
```

- [ ] Replace `LAYOUT_PARAMS` and `LAYOUT_PARAMS_IMPORT` lists with `LayoutParams.STICKY_FIELDS`
- [ ] Replace manual dict building with `layout.to_sticky_dict()`
- [ ] Replace manual dict loading with `LayoutParams.from_sticky_dict(saved)`
- [ ] Add assertion: if any destructive filter key appears in saved JSON, raise an error

### Phase 2 Verification
- [ ] All existing tests pass
- [ ] Process test meet — outputs identical to pre-refactor
- [ ] Verify sticky params save/load cycle works correctly
- [ ] Verify `--regenerate` uses saved layout params correctly

---

## Phase 3: Break Up pdf_generator.py

**Goal:** Extract shared layout logic so pdf_generator.py is just a PDF renderer.
**Effort:** Medium-Large
**Risk:** Medium (many import changes, but behavior is unchanged)
**Depends on:** Phase 2

### 3a. Extend constants.py with Layout Constants

Move from `pdf_generator.py` to `python/core/constants.py`:
- Page dimensions (`PAGE_W`, `PAGE_H`, `PAGE_H_LEGAL`)
- Column positions (`COL_CENTERS`)
- Colors (`RED`, `WHITE`, `BLACK`, `YELLOW_HL`)
- Default text (`DEFAULT_SPORT`, `DEFAULT_TITLE_PREFIX`, `DEFAULT_COPYRIGHT`)
- Font names (`FONT_REGULAR`, `FONT_BOLD`)
- Size defaults (`TITLE1_LARGE`, `TITLE1_SMALL`, etc.)
- Xcel mappings (`XCEL_MAP`, `XCEL_ORDER`)
- `COPYRIGHT_Y`, `NAMES_BOTTOM_Y`

### 3b. Create layout_engine.py

Extract from `pdf_generator.py`:
- `precompute_shirt_data()` (now returns ShirtData)
- `_get_winners_by_event_and_level()`
- `_compute_layout()`
- `_fit_font_size()`
- `_bin_pack_levels()`
- `_level_height()`
- `_space_text()`
- `_clean_name_for_shirt()`
- `_flag_suspicious_name()`
- `_get_winners_with_gym()`
- `_get_all_winner_gyms()`

### 3c. Create rendering_utils.py

Extract shared PyMuPDF drawing functions:
- `_draw_small_caps()`
- `_measure_small_caps_width()`
- `_draw_oval()`
- `_draw_star_polygon()`

These are imported by `order_form_generator.py` already.

### 3d. Update All Imports

- [ ] `idml_generator.py` — change imports from `pdf_generator` to `layout_engine` + `constants`
- [ ] `order_form_generator.py` — change imports to `layout_engine` + `rendering_utils` + `constants`
- [ ] `meet_summary.py` — change imports to `layout_engine` + `constants`
- [ ] `process_meet.py` — update any direct imports from `pdf_generator`
- [ ] `pdf_generator.py` — now imports FROM `layout_engine`, `rendering_utils`, and `constants` instead of defining them

### 3e. Temporary Re-exports (Optional Safety Net)

Add re-exports in `pdf_generator.py` so any external code that imports from it still works:

```python
# Backward compatibility — remove after all imports are updated
from python.core.layout_engine import precompute_shirt_data, _compute_layout, ...
from python.core.constants import PAGE_W, PAGE_H, RED, ...
```

Remove these once all imports are verified.

### Phase 3 Verification
- [ ] All existing tests pass
- [ ] `npm run build` succeeds
- [ ] Process test meet — all 7 outputs identical to Phase 0 baseline
- [ ] Run `python3 -c "from python.core.layout_engine import precompute_shirt_data"` — import works
- [ ] **PyInstaller verification**: Build the binary (`pyinstaller build/pyinstaller/process_meet.spec`), run it against the 3 reference meets (Iowa, Colorado, Utah), compare outputs to baseline. If any new modules aren't found, add them to `hiddenimports` in the spec file.

---

## Phase 4: Publishing Pipeline Fixes

**Goal:** Fix round-trip safety, gym highlights import, and IDML rendering accuracy.
**Effort:** Medium
**Risk:** Low-Medium
**Depends on:** Phase 2

### 4a. Round-Trip Safety Sentinel

Use `shirt_layout.json` (already exists for sticky params) to store an `_source` key:

```python
# After successful IDML import in process_meet.py
saved_layout['_source'] = 'imported'
saved_layout['_import_path'] = idml_path
saved_layout['_import_date'] = datetime.now().isoformat()
# Write to shirt_layout.json (already happens)
```

Before `--regenerate shirt` overwrites:

```python
if saved_layout.get('_source') == 'imported' and not args.force:
    print('WARNING: back_of_shirt.pdf was produced by IDML import.')
    print(f'  Imported from: {saved_layout.get("_import_path", "unknown")}')
    print(f'  Import date:   {saved_layout.get("_import_date", "unknown")}')
    print('Running --regenerate will destroy designer edits.')
    print('Use --force to override.')
    sys.exit(1)
```

This approach is cleaner than a separate sentinel file — `shirt_layout.json` is already the metadata file for the output.

- [ ] Add `_source`, `_import_path`, `_import_date` to saved layout on successful `--import-idml`
- [ ] Check `_source == 'imported'` before `--regenerate shirt` and `--regenerate all`
- [ ] Add `--force` flag to argparse
- [ ] Clear `_source` key when `--regenerate --force` runs
- [ ] Ensure `_source` key is excluded from `LayoutParams.STICKY_FIELDS` (it's metadata, not a layout param)

### 4b. Gym Highlights After IDML Import

Two fixes needed:

1. **Pass saved layout params** — the import path at `process_meet.py:356-362` must pass all saved layout params from `shirt_layout.json` to `generate_gym_highlights_pdf()`, not just `year`/`state`/`name_sort`.

2. **Use overlay approach when source PDF exists** — after import, `back_of_shirt.pdf` exists and has designer edits baked in. The gym highlights should use `generate_gym_highlights_from_pdf()` (overlay on the designer's PDF) rather than `generate_gym_highlights_pdf()` (code-generated).

- [ ] Load saved layout params in import path
- [ ] Pass full LayoutParams to gym highlights generation
- [ ] Switch to overlay approach when imported PDF exists
- [ ] Pass `font_family` and `accent_color` to overlay function (currently hardcoded)

### 4c. IDML Header Underlines — Font Metrics

Replace character-count approximation with actual font measurements:

```python
# Before (idml_generator.py ~line 294):
approx_w = len(header) * hl * 0.52

# After:
import fitz
approx_w = fitz.get_text_length(header, fontname=font_bold, fontsize=hl)
```

- [ ] Fix header underline width calculation in `idml_generator.py`
- [ ] Fix level divider flanking line width calculation (~line 344)
- [ ] Verify IDML underlines match PDF underlines visually

### Phase 4 Verification
- [ ] `--import-idml` creates sentinel file
- [ ] `--regenerate shirt` refuses when sentinel exists (without `--force`)
- [ ] `--regenerate shirt --force` works and removes sentinel
- [ ] Gym highlights after import reflect designer layout params
- [ ] IDML header underlines match PDF width

---

## Phase 5: TypeScript Refactoring

**Goal:** Break up agent-loop.ts, improve type safety, deduplicate LLM client.
**Effort:** Medium
**Risk:** Low-Medium
**Depends on:** Phase 1

### 5a. Split agent-loop.ts

Extract three modules:

**`src/main/tool-definitions.ts`** (~340 lines):
- `getToolDefinitions()` function — pure data, no runtime dependencies
- Tool description constants

**`src/main/context-tools.ts`** (~480 lines):
- `toolRunPython()`, `toolRenderPdfPage()`, `toolOpenFile()`
- `toolListOutputFiles()`, `toolLoadSkill()`, `toolLoadSkillDetail()`
- `toolSaveDraftSkill()`, `toolSaveProgress()`, `toolLoadProgress()`
- Each function takes `AgentContext` as first parameter

**`src/main/process-logger.ts`** (~100 lines):
- `saveProcessLog()`, `extractProgressSummary()`, `extractNextSteps()`

**`agent-loop.ts` retains:**
- `AgentLoop` class with `processMeet()`, `runLoop()`, `continueConversation()`, `queryResults()`
- `executeTool()` dispatch (now delegates to imported context-tools)
- Context/state management

**Dependency direction (no circular imports):**
```
agent-loop.ts → imports from → tool-definitions.ts (pure data, no imports from other project files)
agent-loop.ts → imports from → context-tools.ts (imports from paths.ts, python-manager.ts)
agent-loop.ts → imports from → process-logger.ts (imports from llm-client.ts for types only)
```
`context-tools.ts` does NOT import from `agent-loop.ts` — it receives `AgentContext` as a parameter.

### 5b. ContentBlock Discriminated Union

```typescript
// src/main/llm-client.ts
interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
```

Then update all consumers — TypeScript's narrowing will auto-fix most `!` assertions.

### 5c. Tool Argument Validation Utility

```typescript
// src/main/tools/validation.ts
export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string') throw new Error(`Expected string for '${key}', got ${typeof val}`);
  return val;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`Expected string for '${key}', got ${typeof val}`);
  return val;
}
```

- [ ] Create `src/main/tools/validation.ts`
- [ ] Replace `as string` casts across all tool files

### 5d. LLM Client Consolidation

- [ ] Extract `private parseAnthropicResponse(data: AnthropicResponseBody): LLMResponse`
- [ ] Extract shared request body construction
- [ ] Consolidate `sendAnthropic` and `sendSubscription` into one method with auth config parameter

### 5e. Quick TypeScript Fixes

- [ ] `askUserForChoice` — add window `closed` event listener that rejects the promise
- [ ] `queryConversation` — add context-window check matching `processMeet`'s pattern
- [ ] Create `src/shared/types.ts` — move shared types out of preload and renderer
- [ ] `configStore.setAll` — change parameter from `Record<string, unknown>` to `Partial<AppConfig>`

### Phase 5 Verification
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` — no type errors
- [ ] Process a test meet end-to-end
- [ ] Query feature works (tests queryConversation)
- [ ] Close/reopen window during agent run — no hang

---

## Phase 6: Performance Optimization

**Goal:** Eliminate redundant file I/O and processing.
**Effort:** Small-Medium
**Risk:** Low
**Depends on:** Phase 2 (cached ShirtData), Phase 3 (separated modules)

### 6a. Order Form PDF Batch Optimization

Open the shirt PDF once, pre-build a name→pages lookup, then use it for all 500 athletes:

```python
def generate_order_forms_pdf(shirt_data, output_path, shirt_pdf_path=None):
    # Pre-scan shirt PDF once
    if shirt_pdf_path and os.path.exists(shirt_pdf_path):
        shirt_doc = fitz.open(shirt_pdf_path)
        name_locations = {}
        for page_idx in range(len(shirt_doc)):
            page = shirt_doc[page_idx]
            for name in all_athlete_names:
                quads = page.search_for(name, quads=True)
                if quads:
                    name_locations.setdefault(name, []).append((page_idx, quads))
        # Pass shirt_doc and name_locations to per-athlete rendering
        ...
        shirt_doc.close()
```

- [ ] Refactor `generate_order_forms_pdf` to accept pre-opened shirt doc
- [ ] Pre-scan all names once instead of per-athlete
- [ ] Eliminate 500 file open/close cycles

### 6b. Append-Only Process Log

- [ ] Track last-written message index in `saveProcessLog()`
- [ ] Only append new entries instead of rewriting the entire file
- [ ] Keep file handle open across saves (close on loop exit)

### Phase 6 Verification
- [ ] Order forms generate correctly (compare with pre-refactor)
- [ ] Process log contains all entries (diff with pre-refactor log)
- [ ] Time a full pipeline run — should be noticeably faster for large meets

---

## Phase 7: Polish & Hardening

**Goal:** Remaining P3 items and security hardening.
**Effort:** Small
**Risk:** Low

### 7a. API Key Encryption

- [ ] Replace `electron-store` plaintext storage with Electron's `safeStorage` API for API keys
- [ ] Keep non-sensitive settings in `electron-store`
- [ ] Migration: read existing plaintext keys, encrypt, write back, delete plaintext

### 7b. UPDATER_TOKEN

- [ ] Audit current token scope — revoke if it has write access
- [ ] Create a fine-grained PAT with read-only releases scope
- [ ] Consider making release assets public (simplest for internal app)
- [ ] Remove token from Webpack DefinePlugin if public approach chosen

### 7c. TypeScript Strictness

- [ ] Enable `noUnusedLocals: true` in tsconfig.json
- [ ] Enable `noUnusedParameters: true` in tsconfig.json
- [ ] Fix any resulting errors

### 7d. Remaining P3 Cleanup

- [ ] React keys: add `id` field to `ActivityLogEntry`, use instead of array index
- [ ] Remove `unsafe-eval` from CSP in production builds
- [ ] Restrict Chrome `--remote-allow-origins` to `http://127.0.0.1`
- [ ] Add `encoding='utf-8'` to file opens missing it
- [ ] Move late imports in `process_meet.py` to top of file
- [ ] Replace `l` variable name with `line` in `process_meet.py:264`
- [ ] Make IDML `_uid_counter` an instance variable instead of module global

---

## System-Wide Impact

### Interaction Graph

- `process_meet.py` calls → `layout_engine.py` (new) → `db_builder.py` (queries)
- `pdf_generator.py` calls → `layout_engine.py` + `rendering_utils.py` (new) + `constants.py`
- `idml_generator.py` calls → `layout_engine.py` + `constants.py` (no longer imports from pdf_generator)
- `agent-loop.ts` calls → `tool-definitions.ts` (new) + `context-tools.ts` (new) + `process-logger.ts` (new)
- `llm-client.ts` consolidated internally (no external interface change)

### Error Propagation

- Context managers ensure resources are cleaned up on any exception
- Path traversal checks catch malicious paths before file I/O
- `execFileSync` prevents shell injection at the command level
- `askUserForChoice` timeout prevents infinite hangs

### State Lifecycle Risks

- **Sentinel file** (`back_of_shirt.imported`) is a new piece of state — must be created/deleted correctly
- **Sticky params** persistence is unchanged but validated (destructive filters never persist)
- **ShirtData cache** is computed once and passed through — no persistence risk

### API Surface Parity

- All tool executors maintain the same `(args: Record<string, unknown>) => Promise<string>` signature
- Python CLI interface unchanged (same argparse flags)
- IPC handlers unchanged
- Renderer unchanged

---

## Acceptance Criteria

### Functional
- [ ] All 7 output files (PDF, IDML, order forms PDF, gym highlights PDF, meet summary, winners) generate correctly
- [ ] Outputs are byte-for-byte identical to pre-refactor for the same input data (except for fixed bugs)
- [ ] `--import-idml` round-trip works correctly
- [ ] `--regenerate` is blocked when sentinel exists (without `--force`)
- [ ] Gym highlights after import reflect saved layout params
- [ ] IDML and PDF layouts match when `--min-font-size` is customized
- [ ] Custom `--divider-size` produces correct page groupings

### Non-Functional
- [ ] `npm run build` succeeds
- [ ] `npm run typecheck` passes with zero errors
- [ ] `python3 -m pytest tests/ -v` passes
- [ ] PyInstaller binary bundles correctly with restructured modules
- [ ] Pipeline runs noticeably faster (cached ShirtData, batch order forms)
- [ ] No resource leaks on exceptions (all context managers in place)

### Security
- [ ] `wslpath`/`explorer.exe` calls use `execFileSync` (no shell)
- [ ] `save_to_file`, `chrome_save_to_file`, `save_draft_skill` validate path containment
- [ ] API keys encrypted at rest via `safeStorage`

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Import breakage after pdf_generator.py split | Medium | High | Temporary re-exports, test after each step |
| PyInstaller can't find restructured modules | Medium | High | Test binary build after Phase 3 |
| Subtle layout differences after ShirtData refactor | Low | High | Golden-file comparison of all outputs |
| Sentinel file left in bad state | Low | Medium | `--force` override, clear error messages |
| Context manager changes alter commit/close ordering | Low | Medium | Test each file individually |

---

## Dependencies & Prerequisites

```
Phase 0 (baseline) → required before ALL other phases
Phase 1 (quick wins) → Phase 2 (LayoutParams) → Phase 3 (pdf_generator breakup)
                                                          ↓
                                                   Phase 4 (publishing fixes)
                                                   Phase 6 (performance)

Phase 1 → Phase 5 (TypeScript refactoring) — independent of Python phases
Phase 1 → Phase 7 (polish) — can start anytime after Phase 1
```

- **Phase 0:** Must complete first — captures baselines for regression detection
- **Phase 1 → 2:** Context managers affect the same files as LayoutParams migration
- **Phase 2 → 3:** LayoutParams/ShirtData defined in `models.py` (Phase 2) are used by the extracted `layout_engine.py` (Phase 3). Defining them in models.py avoids a double migration.
- **Phase 4 and 5:** Can run in parallel (Python publishing vs TypeScript, no file overlap)
- **Phase 6:** Depends on Phase 2 (cached ShirtData) and Phase 3 (clean module boundaries)
- **Phase 7:** Can start anytime after Phase 1

---

## Sources & References

### Internal References
- Review findings: 7-agent code review (architecture, TypeScript, Python, security, performance, simplicity, publishing pipeline) — conducted 2026-03-19
- Sticky params bug: `docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md`
- PyMuPDF font loss: `docs/solutions/runtime-errors/pymupdf-insert-text-font-loss-after-show-pdf-page.md`
- PyMuPDF image flip: `docs/solutions/runtime-errors/pymupdf-insert-image-ignores-idml-flip-transform.md`
- IDML spec reference: `docs/idml-specification-v8.0-cs6.pdf`
- IDML reference notes: `docs/idml-reference.md`

### Key Files
- `python/core/pdf_generator.py` — god object being broken up
- `src/main/agent-loop.ts` — monolith being split
- `python/process_meet.py` — parameter explosion epicenter
- `python/core/models.py` — where LayoutParams/ShirtData will live
- `python/core/constants.py` — where layout constants will move
