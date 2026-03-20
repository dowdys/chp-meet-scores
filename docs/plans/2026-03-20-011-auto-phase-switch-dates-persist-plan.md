# Plan 011: Auto Phase Switch for PDF Import, Persist Dates, Regenerate Respects Imports

## Issues

### 1. Agent doesn't switch to import_backs when user provides PDFs mid-conversation
- User provides PDF paths during output_finalize follow-up
- Agent uses run_script + regenerate_output instead of import_pdf_backs
- Results: no imported backs on gym highlights, missing order form backs

### 2. Dates not persisted — agent has to remember to pass them every time
- Dates collected in discovery but lost across regenerations
- Order forms show "TBD" when dates aren't passed explicitly

### 3. regenerate_output doesn't respect imported backs for gym highlights
- After import, calling regenerate_output code-generates gym highlights
- Should use generate_gym_highlights_from_pdf when backs are imported

## Fixes

### Fix 1: Auto-switch to import_backs when PDF paths detected in follow-up
- In agent-loop.ts `continueConversation()`, detect PDF paths in the user's message
- If detected, set `context.currentPhase = 'import_backs'` before running the loop
- Same detection logic as `processMeet()` file path detection

### Fix 2: Persist dates in shirt_layout.json
- When dates are first provided (via build_database or regenerate_output), save to shirt_layout.json
- On all subsequent calls, restore dates from shirt_layout.json if not on CLI
- Add to process_meet.py sticky param save/restore logic

### Fix 3: regenerate_output uses imported backs for gym highlights
- In the --regenerate Python path, check shirt_layout.json for _source='imported'
- If imported, use generate_gym_highlights_from_pdf with back_of_shirt.pdf
- If not imported, use generate_gym_highlights_pdf (code-generated)
