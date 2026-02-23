# Detail: Network Interception Approach

## Steps
1. **Open Network monitoring**: Use Chrome DevTools MCP to monitor network requests before navigating to the results page.
2. **Navigate to the page**: Load the meet results URL. Watch for XHR/Fetch requests.
3. **Filter for data requests**: Look for responses containing JSON with score-like data. Common patterns:
   - REST API: `/api/scores`, `/api/results`, `/v1/athletes`
   - GraphQL: POST to `/graphql` with query body
   - Pagination: URLs with `?page=`, `?offset=`, `?limit=` parameters
4. **Inspect response bodies**: Use `get_network_request` to examine promising responses. Look for arrays of objects with fields like `name`, `score`, `vault`, `level`, etc.
5. **Replay the request**: Once you identify the API endpoint, replay it directly via `evaluate_script` using `fetch()`:
   ```javascript
   () => fetch('/api/scores?meetId=123').then(r => r.json())
   ```
6. **Handle pagination**: If the API paginates, loop through all pages and concatenate results.

## Common API Patterns
- Session-based filtering: API may require session/level/division parameters
- Auth tokens: Some APIs require tokens found in cookies or localStorage. Extract via `document.cookie` or `localStorage.getItem('token')`.
- CORS: Since you're running JS in the page context, CORS is not an issue.

## After Success
Save the full JSON response to a file and process with the appropriate Python adapter.
