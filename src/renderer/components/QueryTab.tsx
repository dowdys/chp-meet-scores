import React, { useState, useRef, useEffect } from 'react';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

const QueryTab: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    const userMsg: Message = { id: nextId.current++, role: 'user', content: question };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const result = await window.electronAPI.queryResults(question);

      const assistantMsg: Message = {
        id: nextId.current++,
        role: 'assistant',
        content: result.success
          ? result.answer || 'No answer returned.'
          : `Error: ${result.error}`,
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      const errorMsg: Message = {
        id: nextId.current++,
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="query-tab">
      <div className="messages-area">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Ask a question about meet results.</p>
            <p className="hint">For example: "Who won the all-around at the Iowa State Championship?"</p>
          </div>
        )}

        {messages.map(msg => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            <div className="message-label">
              {msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}

        {isLoading && (
          <div className="message message-assistant">
            <div className="message-label">Assistant</div>
            <div className="message-content loading">Thinking...</div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="query-input-area">
        <input
          type="text"
          className="query-input"
          placeholder="Ask a question about meet results..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
        />
        <button
          className="send-button"
          onClick={handleSend}
          disabled={isLoading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default QueryTab;
