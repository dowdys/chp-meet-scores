import React, { useState, useEffect, useRef } from 'react';

interface Props {
  meetName: string;
  logSource: 'meet' | 'active';
  onClose: () => void;
  onSuccess?: () => void;
}

const ReportIssueModal: React.FC<Props> = ({ meetName, logSource, onClose, onSuccess }) => {
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending) onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose, sending]);

  const handleSend = async () => {
    if (!note.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await window.electronAPI.sendReportIssue(meetName, note.trim(), logSource);
      if (result.success) {
        onSuccess?.();
        onClose();
      } else {
        setError(result.error || 'Failed to send report.');
      }
    } catch (err) {
      setError('Unexpected error sending report.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="report-issue-overlay" onClick={!sending ? onClose : undefined}>
      <div className="report-issue-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="report-issue-title">Report Issue</h3>
        <p className="report-issue-meet">{meetName}</p>
        <p className="report-issue-description">
          Describe what happened so we can investigate. The process log will be attached automatically.
        </p>
        <textarea
          ref={textareaRef}
          className="report-issue-textarea"
          placeholder="What happened? (e.g., 'The agent couldn't find the meet on ScoreCat even after I gave it the URL...')"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={sending}
          rows={5}
        />
        {error && <p className="report-issue-error">{error}</p>}
        <div className="report-issue-actions">
          <button
            className="report-issue-send"
            disabled={!note.trim() || sending}
            onClick={handleSend}
          >
            {sending ? 'Sending...' : 'Send Report'}
          </button>
          <button
            className="report-issue-cancel"
            disabled={sending}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default ReportIssueModal;
