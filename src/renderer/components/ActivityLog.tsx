import React, { useRef, useLayoutEffect } from 'react';
import { ActivityLogEntry } from '../types';

interface Props {
  entries: ActivityLogEntry[];
  isProcessing: boolean;
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const ActivityLog: React.FC<Props> = ({ entries, isProcessing }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  // Snapshot of scroll state from the PREVIOUS render — used to decide
  // whether to auto-scroll when new entries arrive.
  const prevScroll = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 });

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    // Was the user at (or near) the bottom BEFORE this render added new content?
    // Compare against the previous render's dimensions, not the current ones.
    const prev = prevScroll.current;
    const wasAtBottom = prev.scrollHeight - prev.scrollTop - prev.clientHeight < 60;

    if (wasAtBottom) {
      el.scrollTop = el.scrollHeight;
    }

    // Snapshot current state for the next render
    prevScroll.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, [entries]);

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <h3>Activity Log</h3>
        {isProcessing && <span className="spinner" />}
      </div>
      <div className="activity-log-content" ref={contentRef}>
        {entries.length === 0 && (
          <div className="log-empty">
            Waiting for activity...
          </div>
        )}
        {entries.map((entry, i) => (
          <div key={i} className={`log-entry log-${entry.level}`}>
            <span className="log-time">{formatTime(entry.timestamp)}</span>
            <span className="log-message">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ActivityLog;
