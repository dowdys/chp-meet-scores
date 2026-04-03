# Gym Deduplication & Address Enrichment

## When to Use
Load this skill after `build_database` when the gym report shows:
- **initials_suspects**: Short abbreviations that might match longer gym names (e.g., "TCT" / "Twin City Twisters")
- **potential_duplicates**: Fuzzy matches above 80% similarity
- **Multiple gym names for the same club number** (already auto-merged, but review the merges)

## Step 1: Review Gym Report

After `build_database` completes, its output includes a gym normalization report. Look for:
- `initials_suspects` — high-confidence abbreviation matches
- `potential_duplicates` — fuzzy similarity matches
- `clubnum_merged` — auto-merged by club number (verify these look correct)

If none of these exist, skip to Step 3 (address enrichment).

## Step 2: Interactive Duplicate Review

For each suspected duplicate pair, ask the user using `ask_user`:

```
Question: "Are these the same gym? [SHORT_NAME] and [LONG_NAME]"
Options:
  - "Yes, merge to [LONG_NAME]"
  - "No, they are different gyms"
  - "Not sure — look it up"
```

**If "Not sure — look it up"**: Call `perplexity_gym_lookup` in verify mode:
```json
{
  "mode": "verify",
  "state": "Minnesota",
  "pairs": [{"gym_a": "TCT", "gym_b": "Twin City Twisters"}]
}
```
Present the Perplexity result to the user and ask again.

**If "Yes, merge"**: Use the `rename_gym` tool:
```
rename_gym(meet_name: "...", old_name: "TCT", new_name: "Twin City Twisters")
```
This updates both the local database AND Supabase atomically, preventing the overwrite-on-pull problem. Do NOT use `run_script` with raw SQL for gym merges.

**Batch approach**: If there are many suspects (>5), present them all at once in a single `ask_user` prompt listing each pair, with options:
- "Merge all confirmed pairs"
- "Let me review one at a time"
- "Look them all up with Perplexity"

For "Look them all up": Call `perplexity_gym_lookup` in verify mode with ALL pairs at once (they execute in parallel). Then present results.

## Step 3: Address Enrichment (Optional)

After dedup is complete, ask the user:
```
Question: "Would you like to look up addresses for all [N] gyms? This uses Perplexity API calls."
Options:
  - "Yes, look up addresses"
  - "No, skip addresses"
```

If yes, call `perplexity_gym_lookup` in enrich mode:
```json
{
  "mode": "enrich",
  "state": "Minnesota",
  "gyms": ["Twin City Twisters", "Elite", "Jam Hops Anoka", ...]
}
```

Save the results to a file in the output directory for reference.

## Step 4: Persist Corrections

After all merges are confirmed, save the corrections as persistent aliases using `run_script`:
```python
import urllib.request, json, os
supabase_url = os.environ.get('SUPABASE_URL')
supabase_key = os.environ.get('SUPABASE_KEY')
if supabase_url and supabase_key:
    aliases = [
        {"alias": "TCT", "canonical": "Twin City Twisters", "source": "manual"},
        # ... more aliases
    ]
    req = urllib.request.Request(
        f"{supabase_url}/rest/v1/rpc/persist_aliases",
        data=json.dumps({"p_state": "MN", "p_aliases": aliases}).encode(),
        headers={
            'apikey': supabase_key,
            'Authorization': f'Bearer {supabase_key}',
            'Content-Type': 'application/json',
        },
        method='POST'
    )
    resp = urllib.request.urlopen(req, timeout=10)
    print(f"Aliases persisted: {resp.read().decode()}")
```

This ensures the same corrections apply automatically in future runs.

## Key Rules
- **Always prefer the full/longer gym name** as canonical (e.g., "Twin City Twisters" over "TCT")
- **Club number matches are definitive** — same club number always means same gym
- **Initials matches are high confidence** but need user confirmation
- **Fuzzy matches need careful review** — similar names can be different locations (e.g., "Classic East" vs "Classic West")
- The `perplexity_gym_lookup` tool uses the `sonar` model automatically — do not specify a model parameter, it is already hardcoded in the tool implementation
