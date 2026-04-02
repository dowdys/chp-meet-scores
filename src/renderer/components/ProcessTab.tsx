import React, { useState, useCallback, useEffect, useRef } from 'react';
import ActivityLog from './ActivityLog';
import OutputFiles from './OutputFiles';
import ReportIssueModal from './ReportIssueModal';
import { ActivityLogEntry, AskUserRequest } from '../types';

const US_STATES: Array<{ abbr: string; name: string }> = [
  { abbr: 'AL', name: 'Alabama' }, { abbr: 'AK', name: 'Alaska' }, { abbr: 'AZ', name: 'Arizona' },
  { abbr: 'AR', name: 'Arkansas' }, { abbr: 'CA', name: 'California' }, { abbr: 'CO', name: 'Colorado' },
  { abbr: 'CT', name: 'Connecticut' }, { abbr: 'DE', name: 'Delaware' }, { abbr: 'FL', name: 'Florida' },
  { abbr: 'GA', name: 'Georgia' }, { abbr: 'HI', name: 'Hawaii' }, { abbr: 'ID', name: 'Idaho' },
  { abbr: 'IL', name: 'Illinois' }, { abbr: 'IN', name: 'Indiana' }, { abbr: 'IA', name: 'Iowa' },
  { abbr: 'KS', name: 'Kansas' }, { abbr: 'KY', name: 'Kentucky' }, { abbr: 'LA', name: 'Louisiana' },
  { abbr: 'ME', name: 'Maine' }, { abbr: 'MD', name: 'Maryland' }, { abbr: 'MA', name: 'Massachusetts' },
  { abbr: 'MI', name: 'Michigan' }, { abbr: 'MN', name: 'Minnesota' }, { abbr: 'MS', name: 'Mississippi' },
  { abbr: 'MO', name: 'Missouri' }, { abbr: 'MT', name: 'Montana' }, { abbr: 'NE', name: 'Nebraska' },
  { abbr: 'NV', name: 'Nevada' }, { abbr: 'NH', name: 'New Hampshire' }, { abbr: 'NJ', name: 'New Jersey' },
  { abbr: 'NM', name: 'New Mexico' }, { abbr: 'NY', name: 'New York' }, { abbr: 'NC', name: 'North Carolina' },
  { abbr: 'ND', name: 'North Dakota' }, { abbr: 'OH', name: 'Ohio' }, { abbr: 'OK', name: 'Oklahoma' },
  { abbr: 'OR', name: 'Oregon' }, { abbr: 'PA', name: 'Pennsylvania' }, { abbr: 'RI', name: 'Rhode Island' },
  { abbr: 'SC', name: 'South Carolina' }, { abbr: 'SD', name: 'South Dakota' }, { abbr: 'TN', name: 'Tennessee' },
  { abbr: 'TX', name: 'Texas' }, { abbr: 'UT', name: 'Utah' }, { abbr: 'VT', name: 'Vermont' },
  { abbr: 'VA', name: 'Virginia' }, { abbr: 'WA', name: 'Washington' }, { abbr: 'WV', name: 'West Virginia' },
  { abbr: 'WI', name: 'Wisconsin' }, { abbr: 'WY', name: 'Wyoming' },
];

interface ProcessTabProps {
  pendingEditMeet?: string | null;
  onEditMeetConsumed?: () => void;
}

const ProcessTab: React.FC<ProcessTabProps> = ({ pendingEditMeet, onEditMeetConsumed }) => {
  const [meetName, setMeetName] = useState('');
  const [league, setLeague] = useState('USAG');
  const [gender, setGender] = useState('Women');
  const [state, setState] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [logEntries, setLogEntries] = useState<ActivityLogEntry[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [processedMeet, setProcessedMeet] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<AskUserRequest | null>(null);
  const [customResponse, setCustomResponse] = useState('');
  const [selectedOptions, setSelectedOptions] = useState<Set<number>>(new Set());
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportMessage, setReportMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const customInputRef = useRef<HTMLInputElement>(null);
  const followUpInputRef = useRef<HTMLInputElement>(null);

  // Track cleanup functions for IPC listeners
  const cleanupRef = useRef<(() => void) | null>(null);
  const askCleanupRef = useRef<(() => void) | null>(null);

  const addLogEntry = useCallback((entry: ActivityLogEntry) => {
    setLogEntries(prev => [...prev, entry]);
  }, []);

  // Build the structured meet query from dropdowns + details
  const buildMeetQuery = (): string => {
    // If meetName looks like a file path, pass it through directly (PDF import)
    if (meetName.trim().match(/^["\/]|^[A-Za-z]:\\/)) return meetName.trim();

    const stateName = US_STATES.find(s => s.abbr === state)?.name || state;
    const parts = [`${league} ${gender}'s Gymnastics State Championship`, stateName];
    if (meetName.trim()) parts.push(meetName.trim());
    return parts.filter(Boolean).join(' - ');
  };

  const canProcess = (state !== '' || meetName.trim().match(/^["\/]|^[A-Za-z]:\\/)) && !isProcessing;

  const startProcessing = async (query: string) => {
    if (!query || isProcessing) return;

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
      const result = await window.electronAPI.processMeet(query);

      if (result.success) {
        addLogEntry({
          timestamp: new Date().toISOString(),
          message: 'Processing complete!',
          level: 'success',
        });
        // Use the agent's clean output name if available, otherwise raw input
        setProcessedMeet(result.outputName || query);
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

  const handleProcess = () => {
    const query = buildMeetQuery();
    startProcessing(query);
  };

  // Auto-start edit session when pendingEditMeet is set from My Meets tab
  useEffect(() => {
    if (pendingEditMeet && !isProcessing) {
      startProcessing(`edit: ${pendingEditMeet}`);
      if (onEditMeetConsumed) onEditMeetConsumed();
    }
  }, [pendingEditMeet]);

  // Cleanup listeners on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) cleanupRef.current();
      if (askCleanupRef.current) askCleanupRef.current();
    };
  }, []);

  // Use checkbox UI for 2+ options (allows selecting option + typing additional text).
  // Excluded: resume/start-fresh prompts which work better as simple buttons.
  const isMultiSelect = pendingQuestion
    && pendingQuestion.options.length >= 2
    && !pendingQuestion.options.some(o => o.toLowerCase().includes('start fresh') || o.toLowerCase().includes('resume'));

  const handleChoiceClick = (choice: string) => {
    // Append custom text if the user typed additional comments alongside an option
    let response = choice;
    if (customResponse.trim()) {
      response = choice ? `${choice}\n${customResponse.trim()}` : customResponse.trim();
    }
    if (!response.trim()) return;

    addLogEntry({
      timestamp: new Date().toISOString(),
      message: `You responded: ${response}`,
      level: 'success',
    });

    window.electronAPI.respondToAskUser(response);

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
    if (!pendingQuestion) return;
    // Allow submitting with just text, just options, or both
    if (selectedOptions.size === 0 && !customResponse.trim()) return;
    const chosen = pendingQuestion.options
      .filter((_, i) => selectedOptions.has(i))
      .join('\n');
    // handleChoiceClick will append customResponse if present
    handleChoiceClick(chosen);
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

  const handleContinue = async () => {
    if (!followUpMessage.trim() || isProcessing) return;

    setIsProcessing(true);

    // Re-attach activity log listener
    cleanupRef.current = window.electronAPI.onActivityLog(addLogEntry);
    askCleanupRef.current = window.electronAPI.onAskUser((request: AskUserRequest) => {
      setPendingQuestion(request);
    });

    try {
      const result = await window.electronAPI.continueConversation(followUpMessage.trim());
      setFollowUpMessage('');

      if (result.success) {
        addLogEntry({
          timestamp: new Date().toISOString(),
          message: 'Follow-up complete!',
          level: 'success',
        });
      } else {
        addLogEntry({
          timestamp: new Date().toISOString(),
          message: `Follow-up failed: ${result.error || result.message}`,
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

  const handleFollowUpKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isProcessing) {
      handleContinue();
    }
  };

  const handleBrowsePdf = async () => {
    if (isProcessing) return;
    const result = await window.electronAPI.browseFiles([
      { name: 'PDF Files', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ]);
    if (!result.cancelled && result.paths && result.paths.length > 0) {
      // Join multiple paths with spaces so the agent sees all of them
      setMeetName(result.paths.map(p => `"${p}"`).join(' '));
    }
  };

  return (
    <div className="process-tab">
      <div className="input-section">
        <label className="input-label">
          State Championship Details:
        </label>
        <div className="meet-selectors">
          <select
            className="meet-select"
            value={league}
            onChange={e => setLeague(e.target.value)}
            disabled={isProcessing}
          >
            <option value="USAG">USAG</option>
            <option value="AAU">AAU</option>
          </select>
          <select
            className="meet-select"
            value={gender}
            onChange={e => setGender(e.target.value)}
            disabled={isProcessing}
          >
            <option value="Women">Women</option>
            <option value="Men">Men</option>
          </select>
          <select
            className="meet-select meet-select-state"
            value={state}
            onChange={e => setState(e.target.value)}
            disabled={isProcessing}
          >
            <option value="">Select State...</option>
            {US_STATES.map(s => (
              <option key={s.abbr} value={s.abbr}>{s.name}</option>
            ))}
          </select>
          <input
            id="meet-name"
            type="text"
            className="meet-details-input"
            placeholder="Additional details (e.g. all levels)"
            value={meetName}
            onChange={e => setMeetName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isProcessing}
          />
        </div>
        <div className="input-row">
          <button
            className="process-button"
            onClick={handleProcess}
            disabled={!canProcess}
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
            className="import-button"
            onClick={handleBrowsePdf}
            disabled={isProcessing}
            title="Import designer-edited PDF backs from InDesign (select one or more)"
          >
            Import PDF
          </button>
          <button
            className="reset-button"
            onClick={handleReset}
            disabled={isProcessing}
            title="Clear progress, temp files, and Chrome state for a fresh run"
          >
            Clear Session
          </button>
          <button
            className="import-button"
            style={{ background: '#e67e22' }}
            onClick={() => setShowReportModal(true)}
            title="Send the process log to support with a description of the issue"
          >
            Report Issue
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
                    <span>additional comments or your own response</span>
                  </div>
                  <div className="ask-user-custom-row">
                    <input
                      ref={customInputRef}
                      type="text"
                      className="ask-user-custom-input"
                      placeholder="Type your own response or add comments to selection..."
                      value={customResponse}
                      onChange={e => setCustomResponse(e.target.value)}
                      onKeyDown={handleCustomKeyDown}
                    />
                  </div>
                </div>
                <button
                  className="ask-user-submit-multi"
                  onClick={handleSubmitSelected}
                  disabled={selectedOptions.size === 0 && !customResponse.trim()}
                >
                  {selectedOptions.size > 0
                    ? `Submit Selected (${selectedOptions.size})`
                    : 'Submit Response'}
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
                    <span>type your own response or add comments</span>
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

      {showOutput && !isProcessing && (
        <div className="follow-up-section">
          <div className="follow-up-row">
            <input
              ref={followUpInputRef}
              type="text"
              className="follow-up-input"
              placeholder="Ask for changes... e.g. &quot;Set postmark date to April 4, 2026&quot;"
              value={followUpMessage}
              onChange={e => setFollowUpMessage(e.target.value)}
              onKeyDown={handleFollowUpKeyDown}
              disabled={isProcessing}
            />
            <button
              className="follow-up-button"
              onClick={handleContinue}
              disabled={isProcessing || !followUpMessage.trim()}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {showOutput && processedMeet && (
        <OutputFiles meetName={processedMeet} />
      )}

      {reportMessage && (
        <div style={{
          position: 'fixed', bottom: '20px', right: '20px',
          padding: '12px 20px', borderRadius: '6px', zIndex: 999,
          background: reportMessage.type === 'success' ? '#27ae60' : '#e74c3c',
          color: 'white', fontSize: '13px', boxShadow: '0 4px 12px rgba(0,0,0,0.2)'
        }}>
          {reportMessage.text}
        </div>
      )}

      {showReportModal && (
        <ReportIssueModal
          meetName={processedMeet || meetName || 'Unknown Meet'}
          logSource="active"
          onClose={() => setShowReportModal(false)}
          onSuccess={() => {
            setReportMessage({ text: 'Issue report sent successfully!', type: 'success' });
            setTimeout(() => setReportMessage(null), 4000);
          }}
        />
      )}
    </div>
  );
};

export default ProcessTab;
