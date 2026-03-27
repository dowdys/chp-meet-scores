# CHP Meet Scores — Developer Reference

## Before Starting Work

- Read `~/life/projects/chp-meet-scores/summary.md` for quick context on this project's current state
- If you need specific facts (release status, known bugs, recent changes), check `~/life/projects/chp-meet-scores/items.json`
- Read today's daily note at `~/life/memory/2026-03-20.md` (use today's actual date) to see what other sessions have been working on today
- These files are maintained by an automated memory system — reading them helps you stay in sync with other sessions and bumps access counts to keep important facts fresh

## Overview
Electron + React + TypeScript app that processes gymnastics meet results into championship t-shirt outputs. An AI agent (Claude) runs inside the app, using tools to find meets online, extract scores, build a SQLite database, and generate output files.

## Stack
- **Main process**: Electron + TypeScript (src/main/)
- **Renderer**: React + TypeScript (src/renderer/)
- **Data processing**: Python (python/process_meet.py)
- **Build**: Webpack (webpack.config.js)
- **Agent skills**: Markdown docs (skills/)

## Build & Run
```bash
npm run build                    # Webpack build (main + renderer + preload)
npx electron --remote-debugging-port=9224 dist/main/main.js  # Run in dev
```

## Port Assignments
- 9222 — BROKEN (never use)
- 9223 — Chrome DevTools MCP (shared Windows Chrome)
- 9224 — Electron dev (this app)
- 9225 — App's Chrome instance (for meet scraping)

## Design Principle: Architecture Over Prompting
When the inner agent repeatedly fails to follow instructions (browsing instead of using APIs, calling wrong tools, using bad flag combinations), the fix is NOT more prompting. Make the wrong action **structurally impossible**:
- Split vague tools into typed, purpose-specific tools (e.g., `run_python` → `build_database` + `regenerate_output` + `import_pdf_backs`)
- Use phase-based tool gating so tools are only available when appropriate
- Remove deprecated tools entirely — don't leave them as "legacy fallbacks"
- Enforce invariants in code (e.g., `idmlImported` flag blocks `build_database`)

Every prompt warning replaced by architectural enforcement makes the system more reliable. If you find yourself adding a prompt warning for the third time, build it into the code instead.

## Post-Edit Reminders
- After editing TypeScript: `npm run build` then restart Electron (Node.js caches modules)
- After editing Python: `find python -name __pycache__ -exec rm -rf {} +`

## Key File Locations
| File | Purpose |
|------|---------|
| src/main/agent-loop.ts | Agent orchestration, tool definitions, progress save/load |
| src/main/tools/ | Tool executors (browser, extraction, python, db, search, skill, user) |
| src/main/tools/extraction-tools.ts | Dedicated MSO + ScoreCat extraction tools |
| src/main/chrome-controller.ts | Chrome CDP connection and command execution |
| src/main/llm-client.ts | LLM API client (Anthropic, OpenRouter, Subscription) |
| src/main/main.ts | Electron main process, IPC handlers |
| skills/system-prompt.md | Inner agent's system prompt (loaded at run start) |
| skills/*.md | Skill documents the agent can load on demand |
| python/process_meet.py | Data processing pipeline (parse, DB, quality, outputs) |
| data/ | Working directory for extractions, temp files, logs, SQLite DB |
| data/chp_results.db | Central SQLite database (all meets) |

## Config
- Config file: `~/.config/chp-meet-scores/chp-meet-scores-config.json`
- Output goes to: `~/Gymnastics Champions/{meetName}/`

## Critical Rules

- **NEVER run recursive grep/find on `/home/goduk`** — home contains 50+ GB of transcripts, caches, node_modules, Docker volumes, and model weights. Recursive scans peg disk at 100% for minutes. Instead:
  - Use the **Grep tool** (ripgrep, fast, respects .gitignore) — never `grep` via Bash
  - Target **specific project directories** — e.g., `~/marketplace-autopilot/`, `~/ai-infra/src/`
  - For secrets/credentials: check **`~/secrets.env`** first (all API keys centralized there)
  - For code search: `codebase search "query" --project NAME` CLI
  - For past conversations: `memory search "query"` CLI
