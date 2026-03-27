import React, { useState, useEffect } from 'react';
import type { CloudMeet, CloudMeetFile } from '../types';

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

const CloudMeetsTab: React.FC = () => {
  const [meets, setMeets] = useState<CloudMeet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');

  // Detail view state
  const [selectedMeet, setSelectedMeet] = useState<string | null>(null);
  const [files, setFiles] = useState<CloudMeetFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState<string>('');

  // Filters
  const [filterState, setFilterState] = useState('');
  const [filterYear, setFilterYear] = useState('');

  const loadMeets = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.electronAPI.listCloudMeets();
      if (result.success && result.meets) {
        setMeets(result.meets);
      } else {
        setError(result.error || 'Failed to load meets');
      }
    } catch (err) {
      setError('Connection error. Check your internet connection.');
    }
    setLoading(false);
  };

  useEffect(() => { loadMeets(); }, []);

  const loadFiles = async (meetName: string) => {
    setSelectedMeet(meetName);
    setFilesLoading(true);
    setFiles([]);
    setDownloaded({});
    try {
      const result = await window.electronAPI.getCloudMeetFiles(meetName);
      if (result.success && result.files) {
        setFiles(result.files);
      }
    } catch { /* ignore */ }
    setFilesLoading(false);
  };

  const handleDownload = async (meetName: string, file: CloudMeetFile) => {
    setDownloading(prev => ({ ...prev, [file.filename]: true }));
    try {
      const result = await window.electronAPI.downloadCloudFile(meetName, file.storage_path, file.filename);
      if (result.success && result.localPath) {
        setDownloaded(prev => ({ ...prev, [file.filename]: result.localPath! }));
      }
    } catch { /* ignore */ }
    setDownloading(prev => ({ ...prev, [file.filename]: false }));
  };

  const handleOpen = async (meetName: string, file: CloudMeetFile) => {
    // If already downloaded, open directly
    if (downloaded[file.filename]) {
      window.electronAPI.openPath(downloaded[file.filename]);
      return;
    }
    // Otherwise download first, then open
    setDownloading(prev => ({ ...prev, [file.filename]: true }));
    try {
      const result = await window.electronAPI.downloadCloudFile(meetName, file.storage_path, file.filename);
      if (result.success && result.localPath) {
        setDownloaded(prev => ({ ...prev, [file.filename]: result.localPath! }));
        window.electronAPI.openPath(result.localPath);
      }
    } catch { /* ignore */ }
    setDownloading(prev => ({ ...prev, [file.filename]: false }));
  };

  const handleDownloadAll = async (meetName: string) => {
    for (const file of files) {
      if (!downloaded[file.filename]) {
        await handleDownload(meetName, file);
      }
    }
  };

  // Derive filter options from data
  const states = [...new Set(meets.map(m => m.state))].sort();
  const years = [...new Set(meets.map(m => m.year))].sort().reverse();

  const filtered = meets.filter(m =>
    (!filterState || m.state === filterState) &&
    (!filterYear || m.year === filterYear)
  );

  // Detail view
  if (selectedMeet) {
    const meet = meets.find(m => m.meet_name === selectedMeet);
    return (
      <div className="cloud-meets-tab">
        <div className="cloud-detail-header">
          <button className="cloud-back-button" onClick={() => setSelectedMeet(null)}>
            &larr; Back to List
          </button>
          <h2>{selectedMeet}</h2>
        </div>

        {meet && (
          <div className="cloud-detail-meta">
            <span>{meet.state}</span>
            <span>{meet.year}</span>
            {meet.association && <span>{meet.association}</span>}
            {meet.source && <span>Source: {meet.source}</span>}
            {meet.dates && <span>{meet.dates}</span>}
            <span>v{meet.version}</span>
            <span>{meet.athlete_count} athletes</span>
            <span>{meet.winner_count} winners</span>
            <span>Published {formatDate(meet.published_at)}</span>
          </div>
        )}

        <div className="cloud-files-section">
          <div className="cloud-files-header">
            <h3>Documents</h3>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="cloud-download-all"
                disabled={pulling}
                onClick={async () => {
                  setPulling(true);
                  setPullResult('');
                  try {
                    const result = await window.electronAPI.pullCloudMeet(selectedMeet);
                    if (result.success) {
                      setPullResult(`Pulled ${result.resultsCount} results, ${result.winnersCount} winners to local DB`);
                    } else {
                      setPullResult(`Error: ${result.reason}`);
                    }
                  } catch (err) {
                    setPullResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
                  }
                  setPulling(false);
                }}
              >
                {pulling ? 'Pulling...' : 'Pull to Local DB'}
              </button>
              {files.length > 0 && (
                <button className="cloud-download-all" onClick={() => handleDownloadAll(selectedMeet)}>
                  Download All Files
                </button>
              )}
            </div>
          </div>
          {pullResult && (
            <p className={pullResult.startsWith('Error') ? 'cloud-error' : 'cloud-success'}
               style={{ margin: '4px 0 8px', fontSize: '13px' }}>
              {pullResult}
            </p>
          )}

          {filesLoading && <p className="cloud-loading">Loading files...</p>}

          {!filesLoading && files.length === 0 && (
            <p className="cloud-empty">No documents uploaded for this meet.</p>
          )}

          {files.map(file => (
            <div key={file.filename} className="cloud-file-row">
              <div className="cloud-file-info">
                <span className="cloud-file-name">{file.filename}</span>
                <span className="cloud-file-size">{formatBytes(file.file_size)}</span>
              </div>
              <div className="cloud-file-actions">
                {downloading[file.filename] ? (
                  <span className="cloud-file-progress">Downloading...</span>
                ) : (
                  <>
                    <button
                      className="cloud-file-open"
                      onClick={() => handleOpen(selectedMeet, file)}
                      title="Open in default app (downloads first if needed)"
                    >
                      Open
                    </button>
                    {downloaded[file.filename] ? (
                      <button
                        className="cloud-file-folder"
                        onClick={() => window.electronAPI.showInFolder(downloaded[file.filename])}
                        title="Show in File Explorer"
                      >
                        Show in Folder
                      </button>
                    ) : (
                      <button
                        className="cloud-file-download"
                        onClick={() => handleDownload(selectedMeet, file)}
                        title="Download to output directory"
                      >
                        Save
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="cloud-meets-tab">
      <div className="cloud-header">
        <h2>Central Database</h2>
        <button className="cloud-refresh" onClick={loadMeets} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <p className="cloud-description">
        Meets published from any computer. Click a meet to view and download its documents.
      </p>

      {error && <div className="cloud-error">{error}</div>}

      {!loading && meets.length > 0 && (
        <div className="cloud-filters">
          <select value={filterState} onChange={e => setFilterState(e.target.value)}>
            <option value="">All States</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filterYear} onChange={e => setFilterYear(e.target.value)}>
            <option value="">All Years</option>
            {years.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <span className="cloud-count">{filtered.length} meet{filtered.length !== 1 ? 's' : ''}</span>
        </div>
      )}

      {!loading && meets.length === 0 && !error && (
        <p className="cloud-empty">No meets published yet. Process and finalize a meet to see it here.</p>
      )}

      <div className="cloud-meet-list">
        {filtered.map(meet => (
          <div key={meet.meet_name} className="cloud-meet-card" onClick={() => loadFiles(meet.meet_name)}>
            <div className="cloud-meet-title">{meet.meet_name}</div>
            <div className="cloud-meet-meta">
              <span className="cloud-badge cloud-badge-state">{meet.state}</span>
              <span>{meet.year}</span>
              {meet.association && <span>{meet.association}</span>}
              <span>v{meet.version}</span>
              <span>{meet.athlete_count} athletes</span>
              <span>{meet.winner_count} winners</span>
            </div>
            <div className="cloud-meet-published">
              Published {formatDate(meet.published_at)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CloudMeetsTab;
