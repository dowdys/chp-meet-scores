import React, { useState, useCallback, useEffect, useRef } from 'react';
import ActivityLog from './ActivityLog';
import OutputFiles from './OutputFiles';
import { ActivityLogEntry, AskUserRequest } from '../types';

const ProcessTab: React.FC = () => {
  const [meetName, setMeetName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [logEntries, setLogEntries] = useState<ActivityLogEntry[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [processedMeet, setProcessedMeet] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<AskUserRequest | null>(null);
  const [customResponse, setCustomResponse] = useState('');
  const [selectedOptions, setSelectedOptions] = useState<Set<number>>(new Set());
  const customInputRef = useRef<HTMLInputElement>(null);

  // Track cleanup functions for IPC listeners
  const cleanupRef = useRef<(() => void) | null>(null);
  const askCleanupRef = useRef<(() => void) | null>(null);

  const addLogEntry = useCallback((entry: ActivityLogEntry) => {
    setLogEntries(prev => [...prev, entry]);
  }, []);

  const handleProcess = async () => {
    if (!meetName.trim() || isProcessing) return;

    setIsProcessing(true);
    setShowOutput(false);
    setLogEntries([]);
    setPendingQuestion(null);

    // Listen for activity log messages from main process
    cleanupRef.current = window.electronAPI.onActivityLog(addLogEntry);

    // Listen for ask-user requests from the agent
    askCleanupRef.current = window.electronAPI.onAskUser((request: AskUserRequest) => {
      setPendingQuestion(request);
    });

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
      setPendingQuestion(null);
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
      if (askCleanupRef.current) {
        askCleanupRef.current();
        askCleanupRef.current = null;
      }
    }
  };

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
      if (askCleanupRef.current) askCleanupRef.current();
    };
  }, []);

  // Detect if this is a multi-select question (3+ options that look like meet names)
  const isMultiSelect = pendingQuestion
    && pendingQuestion.options.length >= 3
    && !pendingQuestion.options.some(o => o.toLowerCase().includes('start fresh') || o.toLowerCase().includes('resume'));

  const handleChoiceClick = (choice: string) => {
    if (!choice.trim()) return;

    addLogEntry({
      timestamp: new Date().toISOString(),
      message: `You responded: ${choice}`,
      level: 'success',
    });

    window.electronAPI.respondToAskUser(choice);

    setPendingQuestion(null);
    setCustomResponse('');
    setSelectedOptions(new Set());
  };

  const handleToggleOption = (index: number) => {
    setSelectedOptions(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleSubmitSelected = () => {
    if (!pendingQuestion || selectedOptions.size === 0) return;
    const chosen = pendingQuestion.options
      .filter((_, i) => selectedOptions.has(i))
      .join('\n');
    const response = chosen + (customResponse.trim() ? '\n' + customResponse.trim() : '');
    handleChoiceClick(response);
  };

  const handleCustomSubmit = () => {
    if (customResponse.trim()) {
      handleChoiceClick(customResponse.trim());
    }
  };

  const handleCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (isMultiSelect) {
        handleSubmitSelected();
      } else {
        handleCustomSubmit();
      }
    }
  };

  const handleStop = async () => {
    try {
      await window.electronAPI.stopRun();
      addLogEntry({
        timestamp: new Date().toISOString(),
        message: 'Stop requested — agent will finish current step and save progress.',
        level: 'warning',
      });
    } catch (err) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        message: `Stop failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      });
    }
  };

  const handleReset = async () => {
    try {
      const result = await window.electronAPI.resetSession();
      if (result.success) {
        setLogEntries([]);
        setShowOutput(false);
        setProcessedMeet('');
        setPendingQuestion(null);
        setMeetName('');
      }
    } catch (err) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        message: `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
      });
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
          {isProcessing && (
            <button
              className="stop-button"
              onClick={handleStop}
              title="Stop the running agent gracefully — saves progress and writes log"
            >
              Stop Run
            </button>
          )}
          <button
            className="reset-button"
            onClick={handleReset}
            disabled={isProcessing}
            title="Clear progress, temp files, and Chrome state for a fresh run"
          >
            Clear Session
          </button>
        </div>
      </div>

      <ActivityLog entries={logEntries} isProcessing={isProcessing} />

      {pendingQuestion && (
        <div className="ask-user-overlay">
          <div className="ask-user-modal">
            <div className="ask-user-question">{pendingQuestion.question}</div>

            {isMultiSelect ? (
              <>
                <div className="ask-user-hint">Click to select one or more options:</div>
                <div className="ask-user-options-multi">
                  {pendingQuestion.options.map((option, i) => (
                    <label
                      key={i}
                      className={`ask-user-checkbox-label${selectedOptions.has(i) ? ' selected' : ''}`}
                      onClick={() => handleToggleOption(i)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedOptions.has(i)}
                        onChange={() => handleToggleOption(i)}
                      />
                      <span className="ask-user-option-text">{option}</span>
                    </label>
                  ))}
                </div>
                <div className="ask-user-custom">
                  <div className="ask-user-divider">
                    <span>additional comments (optional)</span>
                  </div>
                  <div className="ask-user-custom-row">
                    <input
                      ref={customInputRef}
                      type="text"
                      className="ask-user-custom-input"
                      placeholder="e.g. also include level 1-5 if you can find it..."
                      value={customResponse}
                      onChange={e => setCustomResponse(e.target.value)}
                      onKeyDown={handleCustomKeyDown}
                    />
                  </div>
                </div>
                <button
                  className="ask-user-submit-multi"
                  onClick={handleSubmitSelected}
                  disabled={selectedOptions.size === 0}
                >
                  Submit Selected ({selectedOptions.size})
                </button>
              </>
            ) : (
              <>
                <div className="ask-user-options">
                  {pendingQuestion.options.map((option, i) => (
                    <button
                      key={i}
                      className="ask-user-option-button"
                      onClick={() => handleChoiceClick(option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <div className="ask-user-custom">
                  <div className="ask-user-divider">
                    <span>or type your own response</span>
                  </div>
                  <div className="ask-user-custom-row">
                    <input
                      ref={customInputRef}
                      type="text"
                      className="ask-user-custom-input"
                      placeholder="Type a response..."
                      value={customResponse}
                      onChange={e => setCustomResponse(e.target.value)}
                      onKeyDown={handleCustomKeyDown}
                    />
                    <button
                      className="ask-user-custom-send"
                      onClick={handleCustomSubmit}
                      disabled={!customResponse.trim()}
                    >
                      Send
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showOutput && processedMeet && (
        <OutputFiles meetName={processedMeet} />
      )}
    </div>
  );
};

export default ProcessTab;
