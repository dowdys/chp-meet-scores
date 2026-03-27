---
title: "Miro API delete-item on frames orphans all children"
category: integration-issues
tags: [miro, api, frames, cleanup]
severity: moderate
date: 2026-03-27
---

## Problem

Deleting a Miro frame via `DELETE /v2/boards/{id}/items/{item_id}` only deletes the frame itself. All shapes, connectors, and items inside become orphaned — floating around the board with no parent.

## Root Cause

Miro's API performs a **shallow delete**. Unlike the Miro UI (which prompts "delete frame and contents?"), the API has no cascade behavior. Children retain their absolute coordinates and become parentless. Connectors are separate top-level items that persist even when both endpoints are deleted.

## Solution

Perform depth-first deletion: query children, delete connectors referencing them, delete children, then delete the frame.

```python
# 1. Get all children via parent_item_id
children = await paginated_get(f"/boards/{board_id}/items?parent_item_id={item_id}")
child_ids = {c["id"] for c in children}

# 2. Delete connectors referencing any child
connectors = await paginated_get(f"/boards/{board_id}/connectors")
for conn in connectors:
    if conn["startItem"]["id"] in child_ids or conn["endItem"]["id"] in child_ids:
        await delete(f"/boards/{board_id}/connectors/{conn['id']}")

# 3. Delete all children
for child in children:
    await delete(f"/boards/{board_id}/items/{child['id']}")

# 4. Delete the frame
await delete(f"/boards/{board_id}/items/{item_id}")
```

## Prevention

- Never assume cascade behavior in third-party APIs. If docs don't explicitly say "deletes children", it doesn't.
- Connectors are first-class board items, not frame children — clean them up separately.
- Fixed in our miro CLI at `/home/goduk/ai-infra/src/integrations/miro_client.py` `handle_delete_item()`.
