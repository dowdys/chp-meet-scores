import Store from 'electron-store';
import * as path from 'path';
import * as crypto from 'crypto';
import { app, safeStorage } from 'electron';

export interface AppConfig {
  apiProvider: 'anthropic' | 'openrouter' | 'subscription';
  apiKey: string;
  model: string;
  githubToken: string;
  outputDir: string;
  perplexityApiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseEnabled: boolean;
  installationId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  designerEmail: string;
}

const defaults: AppConfig = {
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
};

/** Keys that contain sensitive values and should be encrypted at rest. */
const SENSITIVE_KEYS: ReadonlySet<keyof AppConfig> = new Set(['apiKey', 'githubToken', 'perplexityApiKey', 'supabaseAnonKey', 'smtpPassword']);

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

  // ---------------------------------------------------------------------------
  // Encryption helpers — uses Electron's safeStorage (OS keychain / DPAPI)
  // ---------------------------------------------------------------------------

  private encryptValue(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64');
    }
    return value; // Fallback to plaintext if encryption unavailable
  }

  private decryptValue(stored: string): string {
    if (!stored.startsWith('enc:')) {
      return stored; // Plaintext (pre-migration or encryption unavailable)
    }
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      } catch {
        return stored; // Return raw value if decryption fails
      }
    }
    return stored;
  }

  /**
   * Check whether a key holds sensitive data that should be encrypted.
   */
  private isSensitive(key: keyof AppConfig): boolean {
    return SENSITIVE_KEYS.has(key);
  }

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    const value = this.store.get(key);
    // Handle outputDir default after app is ready
    if (key === 'outputDir' && !value && app.isReady()) {
      const defaultDir = path.join(app.getPath('documents'), 'Gymnastics Champions');
      this.store.set('outputDir', defaultDir);
      return defaultDir as AppConfig[K];
    }
    // Lazy-generate installationId on first access
    if (key === 'installationId' && !value) {
      const id = crypto.randomUUID();
      this.store.set('installationId', id);
      return id as AppConfig[K];
    }
    // Decrypt sensitive values and migrate plaintext -> encrypted on first read
    if (this.isSensitive(key) && typeof value === 'string' && value) {
      const decrypted = this.decryptValue(value);
      // If decryption returned the same string it was likely plaintext (pre-migration).
      // Re-encrypt so future reads are fast and the value is stored encrypted.
      if (decrypted === value && safeStorage.isEncryptionAvailable()) {
        const encrypted = this.encryptValue(value);
        // Only re-write if encryption actually changed the value
        if (encrypted !== value) {
          this.store.set(key, encrypted as AppConfig[K]);
        }
      }
      return decrypted as AppConfig[K];
    }
    return value;
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    if (this.isSensitive(key) && typeof value === 'string' && value) {
      this.store.set(key, this.encryptValue(value) as AppConfig[K]);
    } else {
      this.store.set(key, value);
    }
  }

  getAll(): AppConfig {
    return {
      apiProvider: this.get('apiProvider'),
      apiKey: this.get('apiKey'),
      model: this.get('model'),
      githubToken: this.get('githubToken'),
      outputDir: this.get('outputDir'),
      perplexityApiKey: this.get('perplexityApiKey'),
      supabaseUrl: this.get('supabaseUrl'),
      supabaseAnonKey: this.get('supabaseAnonKey'),
      supabaseEnabled: this.get('supabaseEnabled'),
      installationId: this.get('installationId'),
      // SMTP fields kept in AppConfig for backward compat but no longer exposed to UI
      smtpHost: this.get('smtpHost'),
      smtpPort: this.get('smtpPort'),
      smtpUser: this.get('smtpUser'),
      smtpPassword: this.get('smtpPassword'),
      designerEmail: this.get('designerEmail'),
    };
  }

  setAll(settings: Partial<AppConfig>): void {
    const validKeys: (keyof AppConfig)[] = [
      'apiProvider', 'apiKey', 'model', 'githubToken', 'outputDir', 'perplexityApiKey',
      'supabaseUrl', 'supabaseAnonKey', 'supabaseEnabled',
    ];
    for (const key of validKeys) {
      if (key in settings && settings[key] !== undefined) {
        this.set(key, settings[key] as AppConfig[typeof key]);
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
