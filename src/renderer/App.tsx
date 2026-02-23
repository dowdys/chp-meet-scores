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
        {activeTab === 'process' && <ProcessTab />}
        {activeTab === 'query' && <QueryTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </main>
    </div>
  );
};

export default App;
