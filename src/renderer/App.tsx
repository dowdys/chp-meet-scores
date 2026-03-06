import React, { useState } from 'react';
import ProcessTab from './components/ProcessTab';
import QueryTab from './components/QueryTab';
import SettingsTab from './components/SettingsTab';

type TabName = 'process' | 'query' | 'settings';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabName>('process');

  return (
    <div className="app">
      <header className="app-header">
        <h1>Gymnastics Meet Scores</h1>
      </header>

      <nav className="tab-bar">
        <button
          className={`tab-button ${activeTab === 'process' ? 'active' : ''}`}
          onClick={() => setActiveTab('process')}
        >
          Process Meet
        </button>
        <button
          className={`tab-button ${activeTab === 'query' ? 'active' : ''}`}
          onClick={() => setActiveTab('query')}
        >
          Query Results
        </button>
        <button
          className={`tab-button ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          Settings
        </button>
      </nav>

      <main className="tab-content">
        <div style={{ display: activeTab === 'process' ? 'block' : 'none' }}>
          <ProcessTab />
        </div>
        <div style={{ display: activeTab === 'query' ? 'block' : 'none' }}>
          <QueryTab />
        </div>
        <div style={{ display: activeTab === 'settings' ? 'block' : 'none' }}>
          <SettingsTab />
        </div>
      </main>
    </div>
  );
};

export default App;
