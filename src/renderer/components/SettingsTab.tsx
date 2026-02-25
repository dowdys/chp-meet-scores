import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types';

const SettingsTab: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>({
    apiProvider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    githubToken: '',
    outputDir: '',
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [modelCheckResult, setModelCheckResult] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<string>('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const loaded = await window.electronAPI.getSettings();
      setSettings(loaded);
    } catch (err) {
      console.error('Failed to load settings:', err);
    }
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    try {
      const result = await window.electronAPI.saveSettings(settings);
      if (result.success) {
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } else {
        setSaveStatus('error');
      }
    } catch {
      setSaveStatus('error');
    }
  };

  const handleCheckModel = async () => {
    setModelCheckResult('Checking...');
    try {
      const result = await window.electronAPI.checkModelAvailability(settings.apiProvider, settings.model);
      setModelCheckResult(result.available ? 'Model is available!' : 'Model not found.');
    } catch {
      setModelCheckResult('Check failed.');
    }
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaveStatus('idle');
    setModelCheckResult('');
  };

  return (
    <div className="settings-tab">
      <h2>Settings</h2>

      <div className="settings-section">
        <h3>API Provider</h3>
        <div className="radio-group">
          <label className="radio-label">
            <input
              type="radio"
              name="apiProvider"
              value="subscription"
              checked={settings.apiProvider === 'subscription'}
              onChange={() => {
                updateSetting('apiProvider', 'subscription');
                updateSetting('model', 'claude-sonnet-4-6');
              }}
            />
            Claude Subscription (uses your Claude Code login)
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="apiProvider"
              value="anthropic"
              checked={settings.apiProvider === 'anthropic'}
              onChange={() => {
                updateSetting('apiProvider', 'anthropic');
                updateSetting('model', 'claude-sonnet-4-6');
              }}
            />
            Anthropic API Key
          </label>
          <label className="radio-label">
            <input
              type="radio"
              name="apiProvider"
              value="openrouter"
              checked={settings.apiProvider === 'openrouter'}
              onChange={() => {
                updateSetting('apiProvider', 'openrouter');
                updateSetting('model', '');
              }}
            />
            OpenRouter
          </label>
        </div>
        {settings.apiProvider === 'subscription' && (
          <p className="setting-description" style={{ marginTop: '8px', color: '#4a9' }}>
            No API key needed. Uses your Claude Code OAuth token automatically.
            Make sure Claude Code is logged in.
          </p>
        )}
      </div>

      {settings.apiProvider !== 'subscription' && (
        <div className="settings-section">
          <h3>API Key</h3>
          <div className="input-with-toggle">
            <input
              type={showApiKey ? 'text' : 'password'}
              className="settings-input"
              placeholder={settings.apiProvider === 'anthropic' ? 'sk-ant-...' : 'sk-or-...'}
              value={settings.apiKey}
              onChange={e => updateSetting('apiKey', e.target.value)}
            />
            <button
              className="toggle-button"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
      )}

      <div className="settings-section">
        <h3>Model</h3>
        {settings.apiProvider === 'anthropic' || settings.apiProvider === 'subscription' ? (
          <select
            className="settings-select"
            value={settings.model}
            onChange={e => updateSetting('model', e.target.value)}
          >
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
          </select>
        ) : (
          <div className="input-with-button">
            <input
              type="text"
              className="settings-input"
              placeholder="Enter OpenRouter model ID"
              value={settings.model}
              onChange={e => updateSetting('model', e.target.value)}
            />
            <button className="check-button" onClick={handleCheckModel}>
              Check Availability
            </button>
          </div>
        )}
        {modelCheckResult && (
          <p className={`model-check-result ${modelCheckResult.includes('available') ? 'success' : ''}`}>
            {modelCheckResult}
          </p>
        )}
      </div>

      <div className="settings-section">
        <h3>GitHub Token</h3>
        <p className="setting-description">Used for developer notifications (optional)</p>
        <div className="input-with-toggle">
          <input
            type={showGithubToken ? 'text' : 'password'}
            className="settings-input"
            placeholder="ghp_..."
            value={settings.githubToken}
            onChange={e => updateSetting('githubToken', e.target.value)}
          />
          <button
            className="toggle-button"
            onClick={() => setShowGithubToken(!showGithubToken)}
          >
            {showGithubToken ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Output Directory</h3>
        <p className="setting-description">Where processed meet files are saved</p>
        <div className="input-with-button">
          <input
            type="text"
            className="settings-input"
            placeholder="Documents/Gymnastics Champions/"
            value={settings.outputDir}
            onChange={e => updateSetting('outputDir', e.target.value)}
          />
          <button className="browse-button" onClick={() => {/* TODO: native folder dialog */}}>
            Browse
          </button>
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="save-button"
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
        >
          {saveStatus === 'saving' ? 'Saving...' :
           saveStatus === 'saved' ? 'Saved!' :
           saveStatus === 'error' ? 'Error - Try Again' :
           'Save Settings'}
        </button>
      </div>

      <div className="settings-footer">
        <p className="version-info">Gymnastics Meet Scores v0.1.2</p>
        <button
          className="update-button"
          onClick={async () => {
            setUpdateStatus('Checking...');
            try {
              const result = await window.electronAPI.checkForUpdates();
              setUpdateStatus(result.status === 'ready' ? 'ready' : result.message);
            } catch {
              setUpdateStatus('Could not check for updates.');
            }
          }}
        >
          Check for Updates
        </button>
        {updateStatus === 'ready' ? (
          <button
            className="restart-update-button"
            onClick={() => window.electronAPI.restartAndUpdate()}
          >
            Restart &amp; Update Now
          </button>
        ) : (
          updateStatus && <span className="update-status">{updateStatus}</span>
        )}
      </div>
    </div>
  );
};

export default SettingsTab;
