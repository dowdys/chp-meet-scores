---
title: "Chrome tools removed from extraction phase defaults"
category: architecture-patterns
date: 2026-03-25
tags: [extraction, tool-gating, architecture-over-prompting, chrome]
components: [workflow-phases]
severity: p2
---

# Chrome tools removed from extraction phase defaults

## Problem

The extraction phase offered 9 tools including Chrome browsing tools (`chrome_navigate`, `chrome_execute_js`, `chrome_screenshot`, `chrome_click`, `chrome_save_to_file`). Budget models saw these and browsed websites manually instead of using the dedicated `mso_extract`/`scorecat_extract` tools — even when the prompt said "ALWAYS use the dedicated tools."

## Solution

Removed Chrome tools from extraction's default tool set. Only `mso_extract`, `scorecat_extract`, `http_fetch`, and `save_to_file` are available by default. Chrome tools remain accessible via `unlock_tool` for genuinely unknown sources.

The extraction prompt directs the agent to load the `unknown_source_extraction` skill if dedicated tools fail, which guides it through unlocking Chrome and doing structured scraping.

## Where Applied

`src/main/workflow-phases.ts` — extraction phase tools reduced from 9 to 4.

## Related

- `skills/unknown_source_extraction.md` — skeleton skill for Chrome-based extraction of unknown sources
- Discovery phase also has tool gating after clear match (`discoveryMatchFound` flag removes search tools)
