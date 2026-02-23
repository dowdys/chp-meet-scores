import Store from 'electron-store';
import * as path from 'path';
import { app } from 'electron';

export interface AppConfig {
  apiProvider: 'anthropic' | 'openrouter';
  apiKey: string;
  model: string;
  githubToken: string;
  outputDir: string;
}

const defaults: AppConfig = {
  apiProvider: 'anthropic',
  apiKey: '',
  model: 'claude-sonnet-4-6',
  githubToken: '',
  outputDir: '',
};

class ConfigStore {
  private store: Store<AppConfig>;

  constructor() {
    this.store = new Store<AppConfig>({
      name: 'chp-meet-scores-config',
      defaults,
    });

    // Set default output dir if not set (needs app to be ready for path resolution)
    if (!this.store.get('outputDir')) {
      // Will be set properly once app is ready
      const docsPath = app.isReady()
        ? path.join(app.getPath('documents'), 'Gymnastics Champions')
        : '';
      if (docsPath) {
        this.store.set('outputDir', docsPath);
      }
    }
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    const value = this.store.get(key);
    // Handle outputDir default after app is ready
    if (key === 'outputDir' && !value && app.isReady()) {
      const defaultDir = path.join(app.getPath('documents'), 'Gymnastics Champions');
      this.store.set('outputDir', defaultDir);
      return defaultDir as AppConfig[K];
    }
    return value;
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value);
  }

  getAll(): AppConfig {
    return {
      apiProvider: this.get('apiProvider'),
      apiKey: this.get('apiKey'),
      model: this.get('model'),
      githubToken: this.get('githubToken'),
      outputDir: this.get('outputDir'),
    };
  }

  setAll(settings: Record<string, unknown>): void {
    const validKeys: (keyof AppConfig)[] = ['apiProvider', 'apiKey', 'model', 'githubToken', 'outputDir'];
    for (const key of validKeys) {
      if (key in settings) {
        this.store.set(key, settings[key] as AppConfig[typeof key]);
      }
    }
  }

  /**
   * Validate API key format (basic checks).
   */
  validateApiKey(provider: string, key: string): boolean {
    if (!key || key.trim().length === 0) return false;

    if (provider === 'anthropic') {
      return key.startsWith('sk-ant-') && key.length > 20;
    }

    // OpenRouter keys
    if (provider === 'openrouter') {
      return key.startsWith('sk-or-') && key.length > 20;
    }

    return key.length > 10;
  }
}

export const configStore = new ConfigStore();
