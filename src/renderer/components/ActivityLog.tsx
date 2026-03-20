import React, { useRef, useEffect } from 'react';
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
  const logEndRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Track whether user has scrolled up from the bottom
  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUp.current = distanceFromBottom > 50;
  };

  useEffect(() => {
    // Only auto-scroll if user is near the bottom
    if (!userScrolledUp.current) {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries]);

  return (
    <div className="activity-log">
      <div className="activity-log-header">
        <h3>Activity Log</h3>
        {isProcessing && <span className="spinner" />}
      </div>
      <div className="activity-log-content" ref={contentRef} onScroll={handleScroll}>
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
        <div ref={logEndRef} />
      </div>
    </div>
  );
};

export default ActivityLog;
