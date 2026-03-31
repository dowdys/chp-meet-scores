import React, { useState, useEffect } from 'react';
import { AppSettings } from '../types';

const SettingsTab: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>({
    apiProvider: 'anthropic',
    apiKey: '',
    model: 'claude-sonnet-4-6',
    githubToken: '',
    outputDir: '',
    perplexityApiKey: '',
    supabaseUrl: '',
    supabaseAnonKey: '',
    supabaseEnabled: false,
    installationId: '',
    smtpHost: '',
    smtpPort: 587,
    smtpUser: '',
    smtpPassword: '',
    designerEmail: '',
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [showPerplexityKey, setShowPerplexityKey] = useState(false);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [modelCheckResult, setModelCheckResult] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<string>('');
  const [connectionTest, setConnectionTest] = useState<string>('');
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    loadSettings();
    window.electronAPI.getVersion().then((v: string) => setAppVersion(v)).catch(() => {});
    const cleanupReady = window.electronAPI.onUpdateReady(() => {
      setUpdateStatus('ready');
      setUpdateProgress(100);
    });
    const cleanupProgress = window.electronAPI.onUpdateProgress((progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      setUpdateProgress(progress.percent);
      const mbPerSec = (progress.bytesPerSecond / 1024 / 1024).toFixed(1);
      setUpdateStatus(`Downloading... ${progress.percent}% (${mbPerSec} MB/s)`);
    });
    return () => { cleanupReady(); cleanupProgress(); };
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
            <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
            <option value="claude-opus-4-6">Claude Opus 4.6</option>
          </select>
        ) : (() => {
          const KNOWN_MODELS = [
            'qwen/qwen3.5-397b-a17b',
            'minimax/minimax-m2.7',
            'openai/gpt-4.1-mini',
            'google/gemini-2.5-flash',
            'qwen/qwen3-coder',
            'deepseek/deepseek-v3.2-20251201',
          ];
          const isCustom = !KNOWN_MODELS.includes(settings.model);
          return (
            <>
              <select
                className="settings-select"
                value={isCustom ? '_custom' : settings.model}
                onChange={e => {
                  if (e.target.value === '_custom') {
                    updateSetting('model', '');
                  } else {
                    updateSetting('model', e.target.value);
                  }
                }}
              >
                <optgroup label="Recommended">
                  <option value="qwen/qwen3.5-397b-a17b">Qwen 3.5 397B — $0.39/$2.34</option>
                </optgroup>
                <optgroup label="Budget (may require retries)">
                  <option value="minimax/minimax-m2.7">MiniMax M2.7 — $0.36/$1.44</option>
                  <option value="openai/gpt-4.1-mini">GPT-4.1 Mini — $0.40/$1.60</option>
                  <option value="google/gemini-2.5-flash">Gemini 2.5 Flash — $0.30/$2.50</option>
                  <option value="qwen/qwen3-coder">Qwen 3 Coder 480B — $0.22/$1.00</option>
                  <option value="deepseek/deepseek-v3.2-20251201">DeepSeek V3.2 — $0.26/$0.38</option>
                </optgroup>
                <option value="_custom">Custom model ID...</option>
              </select>
              {isCustom && (
                <div className="input-with-button" style={{ marginTop: '8px' }}>
                  <input
                    type="text"
                    className="settings-input"
                    placeholder="Enter OpenRouter model ID (e.g. meta-llama/llama-4-scout)"
                    value={settings.model}
                    onChange={e => updateSetting('model', e.target.value)}
                  />
                  <button className="check-button" onClick={handleCheckModel}>
                    Check
                  </button>
                </div>
              )}
            </>
          );
        })()}
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
        <h3>Perplexity API Key</h3>
        <p className="setting-description">Used to find archived meets not listed on MSO (optional). Get a key at perplexity.ai</p>
        <div className="input-with-toggle">
          <input
            type={showPerplexityKey ? 'text' : 'password'}
            className="settings-input"
            placeholder="pplx-..."
            value={settings.perplexityApiKey}
            onChange={e => updateSetting('perplexityApiKey', e.target.value)}
          />
          <button
            className="toggle-button"
            onClick={() => setShowPerplexityKey(!showPerplexityKey)}
          >
            {showPerplexityKey ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h3>Cloud Sync</h3>
        <p className="setting-description">
          Finalized meets are automatically synced to the central database, accessible from any computer.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
          <button
            className="check-button"
            onClick={async () => {
              setConnectionTest('Testing...');
              try {
                const result = await window.electronAPI.testSupabaseConnection();
                setConnectionTest(result.success ? 'Connected!' : `Failed: ${result.error}`);
              } catch {
                setConnectionTest('Connection test failed.');
              }
            }}
          >
            Test Connection
          </button>
          {connectionTest && (
            <span className={`model-check-result ${connectionTest === 'Connected!' ? 'success' : ''}`}>
              {connectionTest}
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: '#888' }}>
          Installation ID: {settings.installationId || 'Loading...'}
        </div>
      </div>

      <div className="settings-section">
        <h3>Email Settings (Send to Designer)</h3>
        <p className="setting-description">
          Configure SMTP to send IDML files directly to your designer. For Gmail, use smtp.gmail.com port 587
          with an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer"
                     style={{ color: '#5dade2' }}>App Password</a> (requires 2-Step Verification).
        </p>

        <div className="settings-row">
          <label className="settings-label">SMTP Server</label>
          <input
            type="text"
            className="settings-input"
            placeholder="smtp.gmail.com"
            value={settings.smtpHost}
            onChange={e => updateSetting('smtpHost', e.target.value)}
          />
        </div>

        <div className="settings-row">
          <label className="settings-label">Port</label>
          <input
            type="number"
            className="settings-input"
            placeholder="587"
            value={settings.smtpPort}
            onChange={e => updateSetting('smtpPort', parseInt(e.target.value) || 587)}
            style={{ width: '100px' }}
          />
        </div>

        <div className="settings-row">
          <label className="settings-label">Your Email</label>
          <input
            type="email"
            className="settings-input"
            placeholder="you@gmail.com"
            value={settings.smtpUser}
            onChange={e => {
              const email = e.target.value;
              updateSetting('smtpUser', email);
              // Auto-detect SMTP provider
              const domain = email.split('@')[1]?.toLowerCase() || '';
              if (domain === 'gmail.com' || domain === 'googlemail.com') {
                updateSetting('smtpHost', 'smtp.gmail.com');
                updateSetting('smtpPort', 587);
              } else if (domain === 'outlook.com' || domain === 'hotmail.com' || domain === 'live.com') {
                updateSetting('smtpHost', 'smtp-mail.outlook.com');
                updateSetting('smtpPort', 587);
              }
            }}
          />
        </div>

        <div className="settings-row">
          <label className="settings-label">App Password</label>
          <div className="password-field">
            <input
              type={showSmtpPassword ? 'text' : 'password'}
              className="settings-input"
              placeholder="16-character app password"
              value={settings.smtpPassword}
              onChange={e => updateSetting('smtpPassword', e.target.value)}
            />
            <button
              className="toggle-password"
              onClick={() => setShowSmtpPassword(!showSmtpPassword)}
            >
              {showSmtpPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        <div className="settings-row">
          <label className="settings-label">Designer Email</label>
          <input
            type="email"
            className="settings-input"
            placeholder="designer@example.com"
            value={settings.designerEmail}
            onChange={e => updateSetting('designerEmail', e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            className="browse-button"
            onClick={async () => {
              setEmailTestResult('Testing...');
              try {
                const result = await window.electronAPI.testEmail();
                setEmailTestResult(result.success ? 'Test email sent successfully!' : (result.error || 'Test failed.'));
              } catch {
                setEmailTestResult('Test failed.');
              }
            }}
            disabled={!settings.smtpHost || !settings.smtpUser || !settings.smtpPassword || !settings.designerEmail}
          >
            Send Test Email
          </button>
          {emailTestResult && (
            <span style={{
              fontSize: '13px',
              color: emailTestResult.includes('success') ? '#27ae60' : '#e74c3c',
              alignSelf: 'center',
            }}>
              {emailTestResult}
            </span>
          )}
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
          <button className="browse-button" onClick={async () => {
            const result = await window.electronAPI.browseFolder();
            if (!result.cancelled && result.path) {
              updateSetting('outputDir', result.path);
            }
          }}>
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
        <p className="version-info">Gymnastics Meet Scores v{appVersion}</p>
        <button
          className="logs-button"
          onClick={() => window.electronAPI.openLogsFolder()}
        >
          View Process Logs
        </button>
        <button
          className="update-button"
          onClick={async () => {
            setUpdateStatus('Checking...');
            setUpdateProgress(null);
            try {
              const result = await window.electronAPI.checkForUpdates();
              if (result.status === 'ready') {
                setUpdateStatus('ready');
                setUpdateProgress(100);
              } else {
                setUpdateStatus(result.message);
              }
            } catch {
              setUpdateStatus('Could not check for updates.');
            }
          }}
          disabled={updateProgress !== null && updateProgress < 100}
        >
          Check for Updates
        </button>
        {updateProgress !== null && updateProgress < 100 && (
          <div className="update-progress-container">
            <div className="update-progress-bar">
              <div className="update-progress-fill" style={{ width: `${updateProgress}%` }} />
            </div>
            <span className="update-progress-text">{updateStatus}</span>
          </div>
        )}
        {updateStatus === 'ready' ? (
          <span className="update-status" style={{ color: '#27ae60' }}>
            Update downloaded — restarting automatically...
          </span>
        ) : (
          updateProgress === null && updateStatus && <span className="update-status">{updateStatus}</span>
        )}
      </div>
    </div>
  );
};

export default SettingsTab;
