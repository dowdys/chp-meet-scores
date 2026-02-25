import { app } from 'electron';
import { execSync, ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';

class ChromeController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private debugPort = 9225; // 9222=broken on WSL, 9223=user's debug Chrome, 9225=app's dedicated Chrome
  private connectingPromise: Promise<void> | null = null; // mutex for connection

  /**
   * Find Chrome executable path on Windows.
   */
  findChromePath(): string {
    // Check WSL paths first (Windows Chrome accessible from WSL)
    const wslPaths = [
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];

    for (const chromePath of wslPaths) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    // Windows native paths
    const windowsPaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];

    for (const chromePath of windowsPaths) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    // Try Linux Chrome
    try {
      const linuxChrome = execSync('which google-chrome || which google-chrome-stable || which chromium-browser', { encoding: 'utf8' }).trim();
      if (linuxChrome) return linuxChrome;
    } catch {
      // Not found on Linux
    }

    // Try Windows registry as fallback
    try {
      const regResult = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: 'utf8' }
      );
      const match = regResult.match(/REG_SZ\s+(.+)/);
      if (match && match[1]) {
        return match[1].trim();
      }
    } catch {
      // Registry lookup failed
    }

    throw new Error('Chrome not found. Please install Google Chrome.');
  }

  /**
   * Get the user-data-dir path for our dedicated Chrome profile.
   */
  private getUserDataDir(): string {
    // On WSL, Chrome needs a Windows-style path for user-data-dir
    const isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c');
    if (isWSL) {
      return 'C:\\Temp\\chp-chrome-profile';
    }
    return path.join(app.getPath('userData'), 'chrome-profile');
  }

  /**
   * Launch Chrome with remote debugging enabled.
   */
  async launch(): Promise<void> {
    if (this.chromeProcess) {
      return; // Already launched
    }

    // Check if Chrome is already running on our port (leftover from a previous session)
    try {
      const resp = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`);
      if (resp.ok) {
        console.log(`[CHROME] Found existing Chrome on port ${this.debugPort}, reusing it`);
        return; // Port is already active, skip launching
      }
    } catch {
      // Not running, proceed with launch
    }

    const chromePath = this.findChromePath();
    const userDataDir = this.getUserDataDir();

    // Ensure profile directory exists (skip for Windows paths on WSL)
    if (!userDataDir.includes(':\\') && !fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    this.chromeProcess = spawn(chromePath, [
      `--remote-debugging-port=${this.debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-allow-origins=*',
    ], {
      detached: false,
      stdio: 'ignore',
    });

    this.chromeProcess.on('exit', () => {
      this.chromeProcess = null;
      this.browser = null;
      this.page = null;
    });

    // Poll until the debug port is accepting connections (up to 15 seconds)
    await this.waitForDebugPort(15000);
  }

  /**
   * Wait for Chrome's debug port to become available by polling.
   */
  private async waitForDebugPort(timeoutMs: number): Promise<void> {
    const start = Date.now();
    const pollInterval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${this.debugPort}/json/version`);
        if (resp.ok) return; // Port is ready
      } catch {
        // Not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Chrome debug port ${this.debugPort} did not become available within ${timeoutMs / 1000}s`);
  }

  /**
   * Ensure Chrome is launched and connected. Uses a mutex to prevent
   * concurrent launch/connect races when multiple tools run in parallel.
   */
  async ensureConnected(): Promise<void> {
    if (this.browser && this.page) return;
    if (this.connectingPromise) return this.connectingPromise;

    this.connectingPromise = (async () => {
      try {
        await this.launch();
        await this.connect();
      } finally {
        this.connectingPromise = null;
      }
    })();
    return this.connectingPromise;
  }

  /**
   * Connect to the running Chrome instance via CDP with retry logic.
   */
  async connect(): Promise<void> {
    if (this.browser) {
      return; // Already connected
    }

    console.log(`[CHROME] connect: connecting to port ${this.debugPort}...`);
    const maxAttempts = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.browser = await puppeteer.connect({
          browserURL: `http://127.0.0.1:${this.debugPort}`,
        });

        // Reset references if the browser connection drops
        this.browser.on('disconnected', () => {
          console.log('[CHROME] Browser disconnected');
          this.browser = null;
          this.page = null;
        });

        const pages = await this.browser.pages();
        this.page = pages[0] || await this.browser.newPage();

        // Set default timeouts to prevent indefinite hangs
        this.page.setDefaultTimeout(30000);
        this.page.setDefaultNavigationTimeout(30000);

        return; // Success
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts) {
          const delay = attempt * 1000; // 1s, 2s, 3s, 4s backoff
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(`Failed to connect to Chrome after ${maxAttempts} attempts: ${lastError?.message}`);
  }

  /**
   * Navigate to a URL. Reuses the current tab — closes any extra tabs that accumulated.
   */
  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }

    console.log(`[CHROME] navigate: cleanup tabs...`);
    // Clean up extra tabs (keep only our working tab)
    await this.cleanupExtraTabs();

    console.log(`[CHROME] navigate: page.goto(${url.substring(0, 80)})...`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`[CHROME] navigate: goto done, waiting 1500ms...`);
    // Give the page a moment to render dynamic content (React, Flutter, etc.)
    await new Promise(resolve => setTimeout(resolve, 1500));
    console.log(`[CHROME] navigate: complete`);
  }

  /**
   * Close all tabs except the current working tab.
   */
  private async cleanupExtraTabs(): Promise<void> {
    if (!this.browser) return;
    try {
      const pages = await this.browser.pages();
      for (const p of pages) {
        if (p !== this.page) {
          await p.close().catch(() => {}); // Ignore errors closing tabs
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /**
   * Execute JavaScript in the page context and return the result.
   * Times out after 60 seconds to prevent hangs.
   */
  async executeJS(script: string): Promise<unknown> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }
    const timeoutMs = 60000;

    // Use AbortController pattern for reliable timeout
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`JS execution timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);

      // Evaluate the script directly as a page expression
      this.page!.evaluate(script).then(
        (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      );
    });
  }

  /**
   * Execute JavaScript in the page and save the result directly to a file.
   * Returns size and preview instead of full result, keeping agent context small.
   */
  async saveJSToFile(script: string, filePath: string, timeoutMs: number = 60000): Promise<{ size: number; preview: string }> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }

    const maxTimeout = 120000;
    const effectiveTimeout = Math.min(timeoutMs, maxTimeout);

    // Execute with configurable timeout
    const result = await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`JS execution timed out after ${effectiveTimeout / 1000}s`));
        }
      }, effectiveTimeout);

      this.page!.evaluate(script).then(
        (res) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(res);
          }
        },
        (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        }
      );
    });

    // Serialize result to string
    let content: string;
    if (typeof result === 'string') {
      content = result;
    } else {
      content = JSON.stringify(result, null, 2);
    }

    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to file
    fs.writeFileSync(filePath, content, 'utf8');

    const size = Buffer.byteLength(content, 'utf8');
    const preview = content.substring(0, 200);

    return { size, preview };
  }

  /**
   * Take a screenshot and save to a temp file. Returns the file path.
   */
  async screenshot(): Promise<string> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }

    const tempDir = app.getPath('temp');
    const screenshotPath = path.join(tempDir, `chp-screenshot-${Date.now()}.png`);

    await this.page.screenshot({ path: screenshotPath, fullPage: false });
    return screenshotPath;
  }

  /**
   * Close Chrome gracefully.
   */
  close(): void {
    if (this.browser) {
      this.browser.disconnect();
      this.browser = null;
      this.page = null;
    }

    if (this.chromeProcess) {
      this.chromeProcess.kill();
      this.chromeProcess = null;
    }
  }

  /**
   * Check if Chrome is running and connected.
   */
  isConnected(): boolean {
    return this.browser !== null && this.page !== null;
  }
}

export const chromeController = new ChromeController();
