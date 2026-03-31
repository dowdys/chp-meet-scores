import React, { useState, useEffect } from 'react';
import type { UnifiedMeet, OutputFile, CloudMeetFile } from '../types';

/** Human-readable labels for known output files. */
const FILE_LABELS: Record<string, string> = {
  'back_of_shirt.pdf': 'Shirt Back (letter)',
  'back_of_shirt_8.5x14.pdf': 'Shirt Back (legal)',
  'back_of_shirt.idml': 'Shirt Back \u2014 InDesign (letter)',
  'back_of_shirt_8.5x14.idml': 'Shirt Back \u2014 InDesign (legal)',
  'order_forms.pdf': 'Order Forms',
  'gym_highlights.pdf': 'Gym Highlights (letter)',
  'gym_highlights_8.5x14.pdf': 'Gym Highlights (legal)',
  'meet_summary.txt': 'Meet Summary',
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return '\u2014';
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

function getFileLabel(filename: string): string {
  return FILE_LABELS[filename] || filename;
}

function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith('.pdf');
}

function isIdml(filename: string): boolean {
  return filename.toLowerCase().endsWith('.idml');
}

interface Props {
  meet: UnifiedMeet;
  onBack: () => void;
}

const MeetDetailView: React.FC<Props> = ({ meet, onBack }) => {
  // Local files
  const [localFiles, setLocalFiles] = useState<OutputFile[]>([]);
  const [localLoading, setLocalLoading] = useState(false);

  // Cloud files (for cloud-only meets)
  const [cloudFiles, setCloudFiles] = useState<CloudMeetFile[]>([]);
  const [cloudFilesLoading, setCloudFilesLoading] = useState(false);

  // Download state for cloud files
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});

  // Pull to local DB
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState('');

  // Action feedback
  const [actionMessage, setActionMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Send to designer
  const [sending, setSending] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);

  useEffect(() => {
    // Load local files if meet exists locally
    if (meet.source === 'local' || meet.source === 'both') {
      loadLocalFiles();
    }
    // Load cloud files if meet is cloud-only or both
    if (meet.source === 'cloud' || meet.source === 'both') {
      loadCloudFiles();
    }
  }, [meet.meet_name, meet.source]);

  const loadLocalFiles = async () => {
    setLocalLoading(true);
    try {
      const result = await window.electronAPI.getOutputFiles(meet.meet_name);
      if (result.success) {
        setLocalFiles(result.files);
      }
    } catch { /* ignore */ }
    setLocalLoading(false);
  };

  const loadCloudFiles = async () => {
    setCloudFilesLoading(true);
    try {
      const result = await window.electronAPI.getCloudMeetFiles(meet.meet_name);
      if (result.success && result.files) {
        setCloudFiles(result.files);
      }
    } catch { /* ignore */ }
    setCloudFilesLoading(false);
  };

  const showMessage = (text: string, type: 'success' | 'error') => {
    setActionMessage({ text, type });
    setTimeout(() => setActionMessage(null), 4000);
  };

  // --- Local file actions ---

  const handleOpen = async (filename: string) => {
    const result = await window.electronAPI.openFile(meet.meet_name, filename);
    if (!result.success) {
      showMessage(result.error || 'Failed to open file. No app may be registered for this file type.', 'error');
    }
  };

  const handleShowInFolder = async (filename: string) => {
    await window.electronAPI.showInFolder(meet.meet_name, filename);
  };

  const handlePrint = async (filename: string) => {
    const result = await window.electronAPI.printFile(meet.meet_name, filename);
    if (!result.success) {
      showMessage(result.error || 'Print failed.', 'error');
    }
  };

  // --- Cloud file actions ---

  const handleCloudDownload = async (file: CloudMeetFile) => {
    setDownloading(prev => ({ ...prev, [file.filename]: true }));
    try {
      const result = await window.electronAPI.downloadCloudFile(meet.meet_name, file.storage_path, file.filename);
      if (result.success && result.localPath) {
        setDownloaded(prev => ({ ...prev, [file.filename]: result.localPath! }));
      } else {
        showMessage(result.error || 'Download failed.', 'error');
      }
    } catch {
      showMessage('Download failed.', 'error');
    }
    setDownloading(prev => ({ ...prev, [file.filename]: false }));
  };

  const handleCloudOpen = async (file: CloudMeetFile) => {
    if (downloaded[file.filename]) {
      // Already downloaded — open via the safe handler
      await handleOpen(file.filename);
      return;
    }
    // Download first, then open
    setDownloading(prev => ({ ...prev, [file.filename]: true }));
    try {
      const result = await window.electronAPI.downloadCloudFile(meet.meet_name, file.storage_path, file.filename);
      if (result.success && result.localPath) {
        setDownloaded(prev => ({ ...prev, [file.filename]: result.localPath! }));
        await handleOpen(file.filename);
      } else {
        showMessage(result.error || 'Download failed.', 'error');
      }
    } catch {
      showMessage('Failed to download and open file.', 'error');
    }
    setDownloading(prev => ({ ...prev, [file.filename]: false }));
  };

  const handleDownloadAll = async () => {
    const toDownload = cloudFiles.filter(f => !downloaded[f.filename]);
    await Promise.all(toDownload.map(f => handleCloudDownload(f)));
  };

  // --- Pull to local DB ---

  const handlePull = async () => {
    setPulling(true);
    setPullResult('');
    try {
      const result = await window.electronAPI.pullCloudMeet(meet.meet_name);
      if (result.success) {
        setPullResult(`Pulled ${result.resultsCount} results, ${result.winnersCount} winners to local DB`);
      } else {
        setPullResult(`Error: ${result.reason}`);
      }
    } catch (err) {
      setPullResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    setPulling(false);
  };

  // --- Send to Designer ---

  const hasLocalIdml = localFiles.some(f => isIdml(f.name));

  const handleSendToDesigner = async () => {
    setShowSendConfirm(false);
    setSending(true);
    try {
      const result = await window.electronAPI.sendToDesigner(meet.meet_name);
      if (result.success) {
        showMessage('Email sent to designer successfully!', 'success');
      } else {
        showMessage(result.error || 'Failed to send email.', 'error');
      }
    } catch {
      showMessage('Failed to send email.', 'error');
    }
    setSending(false);
  };

  // Determine which files to show based on source
  const hasCloud = meet.source === 'cloud' || meet.source === 'both';
  const hasLocal = meet.source === 'local' || meet.source === 'both';

  // For cloud-only files not present locally
  const cloudOnlyFiles = hasCloud
    ? cloudFiles.filter(cf => !localFiles.some(lf => lf.name === cf.filename))
    : [];

  return (
    <div className="my-meets-tab">
      <div className="cloud-detail-header">
        <button className="cloud-back-button" onClick={onBack}>
          &larr; Back to List
        </button>
        <h2>{meet.meet_name}</h2>
      </div>

      {/* Meet metadata */}
      {meet.cloud && (
        <div className="cloud-detail-meta">
          <span>{meet.cloud.state}</span>
          <span>{meet.cloud.year}</span>
          {meet.cloud.association && <span>{meet.cloud.association}</span>}
          {meet.cloud.dates && <span>{meet.cloud.dates}</span>}
          <span>v{meet.cloud.version}</span>
          <span>{meet.cloud.athlete_count} athletes</span>
          <span>{meet.cloud.winner_count} winners</span>
          <span>Published {formatDate(meet.cloud.published_at)}</span>
        </div>
      )}

      {/* Source badge */}
      <div style={{ marginBottom: '16px' }}>
        {meet.source === 'local' && <span className="source-badge source-local">LOCAL</span>}
        {meet.source === 'cloud' && <span className="source-badge source-cloud">CLOUD</span>}
        {meet.source === 'both' && (
          <>
            <span className="source-badge source-local">LOCAL</span>
            {' '}
            <span className="source-badge source-cloud">CLOUD</span>
          </>
        )}
      </div>

      {/* Action message */}
      {actionMessage && (
        <div className={actionMessage.type === 'success' ? 'cloud-success' : 'cloud-error'}
             style={{ marginBottom: '12px', fontSize: '13px', padding: '8px 12px', borderRadius: '4px' }}>
          {actionMessage.text}
        </div>
      )}

      {/* Send to Designer confirmation */}
      {showSendConfirm && (
        <div className="send-confirm-dialog">
          <p>Send {localFiles.filter(f => isIdml(f.name)).length} IDML file(s) to designer?</p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="cloud-download-all" onClick={handleSendToDesigner}>
              Yes, Send
            </button>
            <button className="cloud-refresh" onClick={() => setShowSendConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Meet-level actions */}
      <div className="cloud-files-header">
        <h3>Documents</h3>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {hasLocal && hasLocalIdml && (
            <button
              className="cloud-download-all"
              style={{ background: '#8e44ad' }}
              disabled={sending}
              onClick={() => setShowSendConfirm(true)}
            >
              {sending ? 'Sending...' : 'Send to Designer'}
            </button>
          )}
          {hasCloud && (
            <button
              className="cloud-download-all"
              disabled={pulling}
              onClick={handlePull}
            >
              {pulling ? 'Pulling...' : 'Pull to Local DB'}
            </button>
          )}
          {cloudOnlyFiles.length > 0 && (
            <button className="cloud-download-all" onClick={handleDownloadAll}>
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

      {/* Local files */}
      {localLoading && <p className="cloud-loading">Loading files...</p>}

      {hasLocal && !localLoading && localFiles.length === 0 && (
        <p className="cloud-empty">No output files in local directory.</p>
      )}

      {localFiles.map(file => (
        <div key={file.name} className="cloud-file-row">
          <div className="cloud-file-info">
            <span className="file-type-badge">{file.name.split('.').pop()?.toUpperCase()}</span>
            <div>
              <span className="cloud-file-label">{getFileLabel(file.name)}</span>
              <span className="cloud-file-size">{formatBytes(file.size)}</span>
            </div>
          </div>
          <div className="cloud-file-actions">
            <button className="cloud-file-open" onClick={() => handleOpen(file.name)}>
              Open
            </button>
            {isPdf(file.name) && (
              <button className="cloud-file-open" style={{ background: '#2980b9' }}
                      onClick={() => handlePrint(file.name)}>
                Print
              </button>
            )}
            <button className="cloud-file-folder" onClick={() => handleShowInFolder(file.name)}>
              Show in Folder
            </button>
          </div>
        </div>
      ))}

      {/* Cloud-only files (not present locally) */}
      {cloudOnlyFiles.length > 0 && (
        <>
          {localFiles.length > 0 && (
            <h4 style={{ color: '#95a5a6', fontSize: '13px', margin: '16px 0 8px' }}>
              Cloud-only files
            </h4>
          )}
          {cloudFilesLoading && <p className="cloud-loading">Loading cloud files...</p>}
          {cloudOnlyFiles.map(file => (
            <div key={file.filename} className="cloud-file-row">
              <div className="cloud-file-info">
                <span className="file-type-badge">{file.filename.split('.').pop()?.toUpperCase()}</span>
                <div>
                  <span className="cloud-file-label">{getFileLabel(file.filename)}</span>
                  <span className="cloud-file-size">{formatBytes(file.file_size)}</span>
                </div>
              </div>
              <div className="cloud-file-actions">
                {downloading[file.filename] ? (
                  <span className="cloud-file-progress">Downloading...</span>
                ) : (
                  <>
                    <button className="cloud-file-open" onClick={() => handleCloudOpen(file)}>
                      Open
                    </button>
                    {downloaded[file.filename] ? (
                      <button className="cloud-file-folder"
                              onClick={() => handleShowInFolder(file.filename)}>
                        Show in Folder
                      </button>
                    ) : (
                      <button className="cloud-file-download" onClick={() => handleCloudDownload(file)}>
                        Save
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
};

export default MeetDetailView;
