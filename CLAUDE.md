# CHP Meet Scores — Developer Reference

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
