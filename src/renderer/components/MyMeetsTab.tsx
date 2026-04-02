import React, { useState, useEffect, useRef } from 'react';
import type { UnifiedMeet } from '../types';
import MeetDetailView from './MeetDetailView';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

interface Props {
  isActive: boolean;
  onEditMeet: (meetName: string) => void;
}

const MyMeetsTab: React.FC<Props> = ({ isActive, onEditMeet }) => {
  const [meets, setMeets] = useState<UnifiedMeet[]>([]);
  const [loading, setLoading] = useState(true);
  const [cloudError, setCloudError] = useState('');
  const [selectedMeet, setSelectedMeet] = useState<UnifiedMeet | null>(null);

  // Filters
  const [filterState, setFilterState] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterSource, setFilterSource] = useState('');

  // Staleness tracking for tab-aware refresh
  const lastFetchRef = useRef<number>(0);
  const STALE_MS = 60_000; // 1 minute

  const loadMeets = async () => {
    setLoading(true);
    setCloudError('');
    try {
      const result = await window.electronAPI.listUnifiedMeets();
      if (result.success) {
        setMeets(result.meets);
        if (result.cloudError) {
          setCloudError(result.cloudError);
        }
      }
    } catch (err) {
      setCloudError('Connection error. Check your internet connection.');
    }
    setLoading(false);
    lastFetchRef.current = Date.now();
  };

  // Initial load
  useEffect(() => {
    loadMeets();
  }, []);

  // Tab-aware refresh: reload if data is stale when tab becomes active
  useEffect(() => {
    if (!isActive) return;
    if (Date.now() - lastFetchRef.current > STALE_MS) {
      loadMeets();
    }
  }, [isActive]);

  // Listen for meet-processed events for auto-refresh
  useEffect(() => {
    const cleanup = window.electronAPI.onMeetProcessed(() => {
      loadMeets();
    });
    return cleanup;
  }, []);

  // Derive filter options from cloud meets (which have state/year metadata)
  const states = [...new Set(meets
    .filter(m => m.cloud)
    .map(m => m.cloud!.state)
  )].sort();

  const years = [...new Set(meets
    .filter(m => m.cloud)
    .map(m => m.cloud!.year)
  )].sort().reverse();

  const filtered = meets.filter(m => {
    if (filterSource && m.source !== filterSource) return false;
    if (filterState && m.cloud?.state !== filterState) return false;
    if (filterYear && m.cloud?.year !== filterYear) return false;
    return true;
  });

  // Detail view
  if (selectedMeet) {
    return (
      <MeetDetailView
        meet={selectedMeet}
        onBack={() => setSelectedMeet(null)}
        onEditMeet={onEditMeet}
      />
    );
  }

  // List view
  return (
    <div className="my-meets-tab">
      <div className="cloud-header">
        <h2>My Meets</h2>
        <button className="cloud-refresh" onClick={loadMeets} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <p className="cloud-description">
        All meets from your computer and the cloud. Click a meet to view and manage its documents.
      </p>

      {cloudError && (
        <div className="cloud-error">
          Cloud: {cloudError}. Local meets are still shown below.
        </div>
      )}

      {/* Filters */}
      {!loading && meets.length > 0 && (
        <div className="cloud-filters">
          <select value={filterSource} onChange={e => setFilterSource(e.target.value)}>
            <option value="">All Sources</option>
            <option value="local">Local Only</option>
            <option value="cloud">Cloud Only</option>
            <option value="both">Local + Cloud</option>
          </select>
          {states.length > 0 && (
            <select value={filterState} onChange={e => setFilterState(e.target.value)}>
              <option value="">All States</option>
              {states.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {years.length > 0 && (
            <select value={filterYear} onChange={e => setFilterYear(e.target.value)}>
              <option value="">All Years</option>
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          )}
          <span className="cloud-count">{filtered.length} meet{filtered.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && meets.length === 0 && !cloudError && (
        <p className="cloud-empty">
          No meets found. Process your first meet in the Process tab to see it here.
        </p>
      )}

      {/* Meet list */}
      <div className="cloud-meet-list">
        {filtered.map(meet => (
          <div
            key={meet.meet_name}
            className="cloud-meet-card"
            onClick={() => setSelectedMeet(meet)}
          >
            <div className="cloud-meet-title">
              {meet.meet_name}
              <span style={{ marginLeft: '8px' }}>
                {(meet.source === 'local' || meet.source === 'both') && (
                  <span className="source-badge source-local">LOCAL</span>
                )}
                {' '}
                {(meet.source === 'cloud' || meet.source === 'both') && (
                  <span className="source-badge source-cloud">CLOUD</span>
                )}
              </span>
            </div>
            <div className="cloud-meet-meta">
              {meet.cloud && (
                <>
                  <span className="cloud-badge cloud-badge-state">{meet.cloud.state}</span>
                  <span>{meet.cloud.year}</span>
                  {meet.cloud.association && <span>{meet.cloud.association}</span>}
                  <span>v{meet.cloud.version}</span>
                  <span>{meet.cloud.athlete_count} athletes</span>
                  <span>{meet.cloud.winner_count} winners</span>
                </>
              )}
              {meet.local && !meet.cloud && (
                <span>{meet.local.fileCount} file{meet.local.fileCount !== 1 ? 's' : ''}</span>
              )}
            </div>
            <div className="cloud-meet-published">
              {meet.cloud
                ? `Published ${formatDate(meet.cloud.published_at)}`
                : meet.local
                  ? `Last modified ${formatDate(meet.local.modified)}`
                  : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default MyMeetsTab;
