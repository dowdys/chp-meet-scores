/**
 * Supabase client singleton for the Electron main process.
 *
 * - Lazy initialization (created on first use when config is set)
 * - Custom electron-store auth storage adapter (no localStorage in main process)
 * - Anonymous auth on first use
 * - Call resetSupabaseClient() when credentials change in Settings
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Store from 'electron-store';
import { BrowserWindow } from 'electron';

// Hardcoded Supabase project credentials (anon key is public by design)
export const SUPABASE_URL = 'https://xkbwrlqmwdmoynfoudha.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhrYndybHFtd2Rtb3luZm91ZGhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ1MzkzMjksImV4cCI6MjA5MDExNTMyOX0.i9WKwH0is3vRi-qM0joKx7h7JjOrarUJ44eTGmTxj2Q';

// Separate store for Supabase auth session tokens (not the main config store)
const sessionStore = new Store({ name: 'supabase-session' });

const electronStorage = {
  getItem(key: string): string | null {
    return (sessionStore.get(key) as string) ?? null;
  },
  setItem(key: string, value: string): void {
    sessionStore.set(key, value);
  },
  removeItem(key: string): void {
    sessionStore.delete(key);
  },
};

let client: SupabaseClient | null = null;
let authInitialized = false;

/**
 * Returns true if Supabase cloud sync is enabled.
 * Always true now that credentials are hardcoded -- can be toggled off in settings if needed.
 */
export function isSupabaseEnabled(): boolean {
  return true;
}

/**
 * Get the Supabase client singleton.
 * Automatically signs in anonymously on first use.
 */
export async function getSupabaseClient(): Promise<SupabaseClient | null> {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: electronStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    });
  }

  // Ensure we have an authenticated session
  if (!authInitialized) {
    const { data: { session } } = await client.auth.getSession();
    if (!session) {
      const { error } = await client.auth.signInAnonymously();
      if (error) {
        console.error('[supabase] Anonymous auth failed:', error.message);
        return null;
      }
    }
    authInitialized = true;

    // Re-auth if session is lost
    client.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        authInitialized = false;
      }
    });
  }

  return client;
}

/**
 * Reset the client when credentials change in Settings.
 * The next call to getSupabaseClient() will create a fresh client.
 */
export function resetSupabaseClient(): void {
  client = null;
  authInitialized = false;
}

/**
 * Set up auto-refresh lifecycle tied to Electron window focus.
 * Supabase docs require manual startAutoRefresh/stopAutoRefresh in non-browser envs.
 */
export function setupAutoRefreshLifecycle(mainWindow: BrowserWindow): void {
  mainWindow.on('focus', () => {
    if (client) {
      client.auth.startAutoRefresh();
    }
  });

  mainWindow.on('blur', () => {
    if (client) {
      client.auth.stopAutoRefresh();
    }
  });
}

/**
 * Test connectivity to the configured Supabase project.
 * Returns success if we can authenticate and query the meets table.
 */
export async function testConnection(): Promise<{ success: boolean; error?: string }> {
  try {
    const supabase = await getSupabaseClient();
    if (!supabase) {
      return { success: false, error: 'Supabase is not configured or disabled' };
    }
    // Simple query to verify connectivity + RLS + schema
    const { error } = await supabase.from('meets').select('meet_name', { count: 'exact', head: true });
    if (error) {
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
