import React, { useState, useCallback } from 'react';
import ActivityLog from './ActivityLog';
import OutputFiles from './OutputFiles';
import { ActivityLogEntry } from '../types';

const ProcessTab: React.FC = () => {
  const [meetName, setMeetName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [logEntries, setLogEntries] = useState<ActivityLogEntry[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [processedMeet, setProcessedMeet] = useState('');

  const addLogEntry = useCallback((entry: ActivityLogEntry) => {
    setLogEntries(prev => [...prev, entry]);
  }, []);

  const handleProcess = async () => {
    if (!meetName.trim() || isProcessing) return;

    setIsProcessing(true);
    setShowOutput(false);
    setLogEntries([]);

    // Listen for activity log messages from main process
    const cleanup = window.electronAPI.onActivityLog(addLogEntry);

    try {
      const result = await window.electronAPI.processMeet(meetName.trim());

      if (result.success) {
        addLogEntry({
          timestamp: new Date().toISOString(),
          message: 'Processing complete!',
          level: 'success',
        });
        setProcessedMeet(meetName.trim());
        setShowOutput(true);
      } else {
        addLogEntry({
          timestamp: new Date().toISOString(),
          message: `Failed: ${result.error}`,
          level: 'error',
        });
      }
    } catch (err) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        message: `Error: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      });
    } finally {
      setIsProcessing(false);
      cleanup();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isProcessing) {
      handleProcess();
    }
  };

  return (
    <div className="process-tab">
      <div className="input-section">
        <label htmlFor="meet-name" className="input-label">
          Enter the name of the meet to process:
        </label>
        <div className="input-row">
          <input
            id="meet-name"
            type="text"
            className="meet-input"
            placeholder="e.g. 2025 Iowa State Championship"
            value={meetName}
            onChange={e => setMeetName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isProcessing}
          />
          <button
            className="process-button"
            onClick={handleProcess}
            disabled={isProcessing || !meetName.trim()}
          >
            {isProcessing ? 'Processing...' : 'Process Meet'}
          </button>
        </div>
      </div>

      <ActivityLog entries={logEntries} isProcessing={isProcessing} />

      {showOutput && processedMeet && (
        <OutputFiles meetName={processedMeet} />
      )}
    </div>
  );
};

export default ProcessTab;
