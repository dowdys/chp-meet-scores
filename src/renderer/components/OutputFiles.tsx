import React, { useState, useEffect } from 'react';
import { OutputFile } from '../types';

interface Props {
  meetName: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'csv': return '[CSV]';
    case 'pdf': return '[PDF]';
    case 'xlsx': return '[XLS]';
    case 'json': return '[JSON]';
    case 'txt': return '[TXT]';
    case 'md': return '[MD]';
    default: return '[FILE]';
  }
}

const OutputFiles: React.FC<Props> = ({ meetName }) => {
  const [files, setFiles] = useState<OutputFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadFiles();
  }, [meetName]);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.getOutputFiles(meetName);
      if (result.success) {
        setFiles(result.files);
      }
    } catch (err) {
      console.error('Failed to load output files:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenFolder = async () => {
    await window.electronAPI.openOutputFolder(meetName);
  };

  if (loading) {
    return <div className="output-files"><p>Loading files...</p></div>;
  }

  return (
    <div className="output-files">
      <div className="output-header">
        <h3>Output Files</h3>
        <button className="open-folder-button" onClick={handleOpenFolder}>
          Open Folder
        </button>
      </div>

      {files.length === 0 ? (
        <p className="no-files">No output files yet.</p>
      ) : (
        <ul className="file-list">
          {files.map((file, i) => (
            <li key={i} className="file-item">
              <span className="file-icon">{getFileIcon(file.name)}</span>
              <span className="file-name">{file.name}</span>
              <span className="file-size">{formatFileSize(file.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default OutputFiles;
