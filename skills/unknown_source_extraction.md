# Unknown Source Extraction

Use this skill when a meet is NOT available on MeetScoresOnline or ScoreCat and you need to extract data from an unfamiliar website.

## Prerequisites
Before loading this skill, you MUST have:
1. Confirmed the meet is not on MSO (mso_extract returned no data or meet not found)
2. Confirmed the meet is not on ScoreCat (scorecat_extract returned no data or meet not found)
3. Used Perplexity (via run_script or web_search) to identify WHERE the meet results are hosted
4. Have a confirmed URL for the meet results

Do NOT load this skill to "explore" — you should already know the target URL.

## Setup
Use `unlock_tool` to access Chrome tools:
- `chrome_navigate`
- `chrome_execute_js`
- `chrome_save_to_file`
- `chrome_screenshot`
- `chrome_click`

## Extraction Workflow
1. Navigate to the confirmed URL
2. Take a screenshot to understand the page structure
3. Write a JS extraction script that pulls athlete data into the standard format:
   ```json
   {
     "name": "First Last",
     "gym": "Gym Name",
     "session": "1",
     "level": "5",
     "division": "Junior A",
     "vault": "9.250",
     "bars": "9.100",
     "beam": "8.950",
     "floor": "9.300",
     "aa": "36.600"
   }
   ```
4. Use `chrome_save_to_file` to save the extracted JSON array
5. Verify the data: check athlete count, level distribution, score ranges

## Output
Save the extracted data as a JSON array of athlete objects in the data directory.
The file will be passed to `build_database` with `source: "generic"` in the database phase.

## Status: Skeleton
This skill is a placeholder. It will be expanded with site-specific adapters and more robust extraction patterns as new sources are encountered.
