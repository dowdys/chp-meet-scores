# Detail: DOM Scraping Approach

## Steps
1. **Inspect page structure**: Run via `evaluate_script`:
   ```javascript
   () => {
     const tables = document.querySelectorAll('table');
     return { tableCount: tables.length, bodyHTML: document.body.innerHTML.substring(0, 2000) };
   }
   ```
2. **Identify score containers**: Look for:
   - `<table>` elements with athlete rows
   - `<div>` grids with class-based columns (like MSO's `.td_1`, `.td_2` pattern)
   - `<tr>` rows with `data-*` attributes containing score values
3. **Extract data**: Build a querySelectorAll + map script that pulls name, gym, session, level, division, and scores from each row.
4. **Handle pagination/lazy loading**: If only partial data is visible, look for:
   - "Load More" buttons to click
   - Scroll-triggered loading (scroll to bottom repeatedly)
   - Page navigation links
5. **Download extracted data**: Store in `window.__scrapedData`, then trigger a blob download as TSV/JSON.

## Common MSO DOM Patterns
- `.td_1` through `.td_N` class naming for table cell columns
- `.event` class cells for score data with `data-score` attribute + `<sup>` decimal
- Filter dropdowns for Session, Level, Division (set to "ALL" before scraping)

## Tips
- Always set filters to show ALL data before scraping
- Check if the page uses client-side rendering (data might not be in initial HTML)
- If rows are dynamically added, wait for the table to finish loading before scraping
