# Cloud Meets Tab -- UI/UX Design Document

## Design Direction

**Tone: Industrial-utilitarian, data-dense.**

This is a desktop tool for gymnastics meet managers. The existing app uses a functional, no-nonsense aesthetic: dark nav bar (`#2c3e50`/`#34495e`), light gray content area (`#f5f5f5`), system fonts, 8px-radius cards, bold action buttons in semantic colors (green for primary, blue for secondary, red for destructive). The Cloud Meets tab extends this vocabulary without introducing new visual ideas. Every element earns its pixels by communicating state or enabling action.

The one memorable thing: the sync status system. Each meet card carries a clear, color-coded badge that tells you instantly whether you have it locally, whether it is only in the cloud, or whether a newer version exists. This is the tab's core information hierarchy and everything else supports it.

---

## Component Architecture

```
CloudMeetsTab (src/renderer/components/CloudMeetsTab.tsx)
  |
  +-- ConnectionBanner           (inline, not a separate file)
  |     Shows connection state + Refresh button
  |
  +-- MeetFilters                (inline)
  |     State dropdown, Year dropdown, Search text input
  |
  +-- MeetList                   (inline)
  |     Maps over filtered meets, renders MeetCard for each
  |
  +-- MeetCard                   (inline)
  |     Summary row with sync badge, expand/collapse toggle
  |
  +-- CloudMeetDetail            (src/renderer/components/CloudMeetDetail.tsx)
        Expanded view: metadata, document list, download actions
```

### Why this split

Keep it to two files total. `CloudMeetsTab.tsx` contains everything except the detail view. The detail view goes in `CloudMeetDetail.tsx` because it has its own async lifecycle (fetching file lists, tracking download progress per file) and will grow independently as features like "open in default app" get added.

Do NOT extract `ConnectionBanner`, `MeetFilters`, or `MeetCard` into their own files. They are small, tightly coupled to the parent's state, and extracting them creates indirection without benefit. If any of these grows past ~80 lines, revisit.

---

## State Management

Plain React hooks. No Context, no external state library. The app currently uses `useState` + `useEffect` + IPC calls everywhere, and this tab has the same complexity level.

### State in `CloudMeetsTab`

```typescript
// Connection
const [connectionStatus, setConnectionStatus] =
  useState<'checking' | 'connected' | 'not-configured' | 'error'>('checking');

// Meet list data
const [meets, setMeets] = useState<CloudMeet[]>([]);
const [loading, setLoading] = useState(true);
const [error, setError] = useState<string | null>(null);

// Filters
const [filterState, setFilterState] = useState('');
const [filterYear, setFilterYear] = useState('');
const [searchQuery, setSearchQuery] = useState('');

// Selection / detail view
const [selectedMeet, setSelectedMeet] = useState<string | null>(null);
// null = list view, meet_name string = detail view

// Bulk action state
const [fetchingMeet, setFetchingMeet] = useState<string | null>(null);
// Which meet is currently being fetched/downloaded (null = none)
```

### State in `CloudMeetDetail`

```typescript
interface Props {
  meetName: string;
  onBack: () => void;
  onDataFetched: () => void;  // triggers parent to refresh list
}

const [detail, setDetail] = useState<CloudMeetDetailData | null>(null);
const [loading, setLoading] = useState(true);
const [downloadingFile, setDownloadingFile] = useState<string | null>(null);
// Which specific filename is currently downloading
const [downloadingAll, setDownloadingAll] = useState(false);
const [fetchingData, setFetchingData] = useState(false);
```

### Types (add to `src/shared/types.ts`)

```typescript
export type SyncStatus = 'downloaded' | 'available' | 'update-available';

export interface CloudMeet {
  meet_name: string;
  state: string;
  year: string;
  association: string;
  source: string;
  dates: string | null;
  published_at: string;
  published_by: string;
  version: number;
  results_count: number;
  winners_count: number;
  sync_status: SyncStatus;
  local_version: number | null;  // null if not downloaded
}

export interface CloudMeetFile {
  filename: string;
  storage_path: string;
  file_size: number;
  content_type: string;
  is_designer_edited: boolean;
  uploaded_at: string;
  is_local: boolean;  // true if already downloaded to output dir
}

export interface CloudMeetDetailData {
  meet: CloudMeet;
  files: CloudMeetFile[];
  level_summary: { level: string; athlete_count: number; winner_count: number }[];
}
```

---

## Layout and Visual Design

### Connection Banner

Full-width bar at the top of the tab content area, below the filter row.

**Connected state:**
- Background: `#d5f5e3` (light green)
- Left border: 4px solid `#27ae60`
- Text: "Connected to Supabase" in `#1e8449`
- Right side: subtle "Refresh" link-button in `#3498db`

**Not configured state:**
- Background: `#fef9e7` (light yellow)
- Left border: 4px solid `#f39c12`
- Text: "Cloud sync not configured. Go to Settings to connect." with "Settings" as a clickable link
- The link should call `setActiveTab('settings')` via a callback prop

**Error state:**
- Background: `#fdedec` (light red)
- Left border: 4px solid `#e74c3c`
- Text: "Could not connect to Supabase. Check your settings." + "Retry" button

**Checking state:**
- Background: `#eaf2f8` (light blue)
- Text: "Checking connection..." with the existing `.spinner` class

### Filter Row

Horizontal bar below the connection banner. Uses the same `gap: 8px` flex layout as the `.meet-selectors` row in ProcessTab.

```
[State dropdown] [Year dropdown] [Search input........................] [Refresh button]
```

- **State dropdown**: Reuse the `US_STATES` array from ProcessTab (extract to a shared constant in a later cleanup). Same `.meet-select` styling. Default option: "All States".
- **Year dropdown**: Generated from the meets data. Shows unique years sorted descending. Default: "All Years". Same `.meet-select` styling.
- **Search input**: Same `.meet-details-input` styling. Placeholder: "Search meets..." Filters on `meet_name` client-side (no debounce needed for <100 meets).
- **Refresh button**: Uses existing `.import-button` styling (blue, `#2980b9`). Label: "Refresh".

### Meet List

Vertical stack of cards. Each card is a self-contained summary.

**Card layout (`.cloud-meet-card`):**

```
+-------------------------------------------------------------------+
|  [SyncBadge]  Georgia State Championships 2026          v3        |
|  GA  |  USAG  |  Published Mar 15, 2026  |  492 athletes         |
|                                        [View Details]             |
+-------------------------------------------------------------------+
```

- Background: `white`
- Border: `1px solid #e0e0e0` (same as `.file-item`)
- Border-radius: `8px`
- Padding: `16px 20px`
- Margin-bottom: `8px`
- On hover: `border-color: #3498db` with `transition: border-color 0.2s`

**Sync status badge (`.sync-badge`):**
- **Downloaded**: Background `#d5f5e3`, text `#1e8449`, label "Downloaded"
- **Available**: Background `#eaf2f8`, text `#2980b9`, label "Available"
- **Update Available**: Background `#fef9e7`, text `#e67e22`, label "Update Available"

All badges: `display: inline-block`, `padding: 4px 12px`, `border-radius: 12px`, `font-size: 13px`, `font-weight: 600`, `text-transform: uppercase`, `letter-spacing: 0.5px`.

**Card metadata line**: `font-size: 15px`, `color: #7f8c8d`. Pipe-separated. Uses same muted color as `.setting-description`.

**"View Details" button**: Uses `.toggle-button` / `.browse-button` aesthetic -- gray background, border, hover darkens. Positioned bottom-right of the card via flex.

### Meet Detail View (CloudMeetDetail)

Replaces the list view when a meet is selected (not a modal, not a slide-in -- just swaps content). A "Back to list" link at the top provides navigation.

**Header section:**
```
< Back to list

Georgia State Championships 2026                    [SyncBadge]
State: GA  |  Year: 2026  |  Source: MSO  |  USAG
Dates: March 14-15, 2026
Published Mar 15, 2026 by installation abc123  |  Version 3
492 athletes  |  287 winners across 8 levels
```

- Meet name: `font-size: 24px`, `font-weight: 600`, `color: #2c3e50`
- Metadata: `font-size: 16px`, `color: #555`
- Stats line: `font-size: 16px`, `font-weight: 500`

**Level summary (optional, if data available):**

A compact horizontal bar showing athlete/winner counts per level. Only shown if `level_summary` is non-empty. Use a simple table or definition list.

```
Level 3: 45 athletes, 28 winners
Level 4: 62 athletes, 35 winners
...
```

Styled like the existing `.file-list` items but without icons.

**Document list:**

Heading: "Documents" (`font-size: 20px`, same as `.settings-section h3`)

Each document is a row:
```
+-------------------------------------------------------------------+
| [PDF]  back_of_shirt.pdf         4.2 MB    Mar 16    [Download]   |
|        Designer edited                                             |
+-------------------------------------------------------------------+
```

Reuse the existing `.file-item` styling exactly. Add:
- Download button: `.import-button` style (blue) but smaller (`padding: 8px 16px`, `font-size: 14px`)
- If file is already local, show "Open" button instead (green, `.process-button` style but small)
- "Designer edited" badge: small inline badge, same style as sync badges but with `#8e44ad` (purple) background `#f4ecf7`
- Download in progress: replace button text with "Downloading..." and disable

**Bulk action bar:**

Below the document list. Horizontal flex row with gap.

```
[Download All Files]  [Fetch Data to Local DB]
```

- "Download All Files": `.import-button` style (blue, `#2980b9`)
- "Fetch Data to Local DB": `.process-button` style (green, `#27ae60`)
- Both show spinner/progress text when active
- Both disabled while any operation is in progress

---

## Loading, Error, and Empty States

### Loading state (initial list fetch)

Center of the tab content area:
```
[spinner]
Loading cloud meets...
```
Use the existing `.spinner` class. Text in `#7f8c8d`, italic. Same pattern as QueryTab's `empty-state`.

### Loading state (detail fetch)

Same pattern, within the detail view area.

### Error state (list fetch failed)

```
Could not load meets from Supabase.

[error message in monospace, color: #e74c3c]

[Retry button]
```

Retry button uses `.import-button` styling.

### Empty state (no meets match filters)

```
No meets found.
```

If filters are active: "No meets match your filters. Try broadening your search."

If no meets exist at all: "No meets have been published to the cloud yet. Process and finalize a meet to publish it."

Same styling as QueryTab's `.empty-state`.

### Empty state (not configured)

The connection banner already handles this, but the list area should also show:

```
Cloud sync is not configured.

Set your Supabase URL and key in Settings to browse
meets published by other installations.
```

Centered, muted, same `.empty-state` styling.

### Download progress

Individual file downloads: button text changes to "Downloading..." with disabled state.

Bulk "Download All": replace button text with "Downloading 3 of 7..." and show a progress bar beneath the button row. Use the existing `.update-progress-bar` / `.update-progress-fill` styles.

"Fetch Data": button text changes to "Fetching..." with spinner.

---

## Accessibility

1. **Keyboard navigation**: All interactive elements (buttons, dropdowns, inputs, cards) must be focusable via Tab. Meet cards should use `<button>` or `role="button"` with `tabIndex={0}` and `onKeyDown` handler for Enter/Space.

2. **ARIA labels**:
   - Connection banner: `role="status"`, `aria-live="polite"` so screen readers announce connection changes
   - Sync badges: `aria-label="Sync status: Downloaded"` (the visual text alone is sufficient but the badge element should have the label)
   - Download buttons: `aria-label="Download back_of_shirt.pdf"` (include filename for context)
   - Filter inputs: proper `<label>` elements or `aria-label` attributes

3. **Focus management**: When navigating from list to detail view, focus the "Back to list" link. When navigating back, focus the card that was previously selected.

4. **Color contrast**: All text/background combinations already meet WCAG AA:
   - Green badge: `#1e8449` on `#d5f5e3` = 4.8:1
   - Blue badge: `#2980b9` on `#eaf2f8` = 4.5:1
   - Orange badge: `#e67e22` on `#fef9e7` = 3.2:1 (fails AA for small text -- bump to `#c0620b` for 4.5:1)
   - Error text: `#e74c3c` on white = 3.9:1 (bump to `#c0392b` for 4.7:1)

5. **Screen reader semantics**:
   - Meet list: `<ul role="list">` with `<li>` for each card
   - Document list: same `<ul>` / `<li>` pattern
   - Filter area: wrap in `<fieldset>` with `<legend>` "Filter meets"

---

## IPC Channels (ElectronAPI additions)

```typescript
// Add to ElectronAPI interface in src/shared/types.ts:

// Cloud meets
testSupabaseConnection: () => Promise<{ connected: boolean; error?: string }>;
listCloudMeets: (filters?: { state?: string; year?: string }) =>
  Promise<{ success: boolean; meets: CloudMeet[]; error?: string }>;
getCloudMeetDetail: (meetName: string) =>
  Promise<{ success: boolean; detail: CloudMeetDetailData; error?: string }>;
downloadCloudFile: (meetName: string, filename: string) =>
  Promise<{ success: boolean; localPath?: string; error?: string }>;
downloadAllCloudFiles: (meetName: string) =>
  Promise<{ success: boolean; downloaded: number; error?: string }>;
fetchCloudMeetData: (meetName: string) =>
  Promise<{ success: boolean; results_count?: number; winners_count?: number; error?: string }>;
```

---

## App.tsx Integration

Add the tab to the existing tab bar. The `TabName` type becomes `'process' | 'query' | 'cloud' | 'settings'`. The Cloud Meets tab needs a callback to navigate to Settings (for the "not configured" state), so `App.tsx` passes `onNavigateToSettings={() => setActiveTab('settings')}` as a prop.

```typescript
type TabName = 'process' | 'query' | 'cloud' | 'settings';
```

Tab order in the nav: Process Meet | Query Results | Cloud Meets | Settings

The `display: block/none` pattern continues (no unmounting, keeps state alive across tab switches). This means the initial connection check fires once on mount and the meet list stays cached when the user switches to another tab.

---

## CSS Organization

All new styles go in `src/renderer/styles/app.css`, appended after the existing Output Files section. New class name prefix: `.cloud-` for all Cloud Meets tab styles. This avoids collisions and makes it easy to find them.

Key new classes:
- `.cloud-meets-tab` -- outer container, same flex column layout as `.process-tab`
- `.cloud-connection-banner` -- status bar with variants `.connected`, `.not-configured`, `.error`, `.checking`
- `.cloud-filters` -- filter row
- `.cloud-meet-card` -- individual meet card
- `.cloud-sync-badge` -- sync status pill with variants `.downloaded`, `.available`, `.update-available`
- `.cloud-detail` -- detail view container
- `.cloud-detail-header` -- header section
- `.cloud-detail-docs` -- document list
- `.cloud-detail-actions` -- bulk action bar
- `.cloud-doc-item` -- individual document row
- `.cloud-doc-badge` -- "Designer edited" badge
- `.cloud-back-link` -- "< Back to list" navigation
- `.cloud-empty` -- empty state container
- `.cloud-loading` -- loading state

---

## Interaction Flows

### Flow 1: First visit, not configured

1. Tab mounts, calls `testSupabaseConnection()`
2. Connection check returns `not-configured`
3. Banner shows yellow "not configured" message with Settings link
4. List area shows empty state with setup instructions
5. User clicks "Settings" link, tab switches to Settings
6. User configures Supabase, saves
7. User switches back to Cloud Meets tab
8. Tab detects settings changed (via `useEffect` on tab visibility or a simple re-check on focus), re-tests connection
9. Connection succeeds, banner turns green, list loads

### Flow 2: Browse and download a meet

1. Tab shows green banner, meets are loaded
2. User optionally filters by state/year/search
3. User clicks "View Details" on a meet card with "Available" badge
4. Detail view loads, showing metadata and document list
5. User clicks "Download All Files"
6. Button shows progress: "Downloading 1 of 5..."
7. Completion: button returns to normal, all file rows now show "Open" instead of "Download"
8. User clicks "Fetch Data to Local DB"
9. Button shows "Fetching..."
10. Completion: success message, parent list refreshes, badge changes to "Downloaded"

### Flow 3: Update available

1. User sees meet card with orange "Update Available" badge showing "v2 (local: v1)"
2. User clicks "View Details"
3. Detail view shows current version info
4. "Fetch Data" button label: "Update to v2"
5. "Download All Files" button label: "Re-download Files"
6. User fetches data, badge changes to "Downloaded"

---

## Implementation Order

1. Add types to `src/shared/types.ts`
2. Add IPC channels to `ElectronAPI` and implement handlers in `src/main/main.ts` (stubs first, real logic in Phase 3)
3. Create `CloudMeetsTab.tsx` with connection banner + filter bar + meet list
4. Create `CloudMeetDetail.tsx` with metadata display + document list + actions
5. Add CSS to `app.css`
6. Wire into `App.tsx`
7. Test with mock data, then connect to real Supabase
