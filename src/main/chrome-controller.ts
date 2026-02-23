import { app } from 'electron';
import { execSync, ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer-core';

class ChromeController {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private debugPort = 9222;

  /**
   * Find Chrome executable path on Windows.
   */
  findChromePath(): string {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];

    for (const chromePath of possiblePaths) {
      if (fs.existsSync(chromePath)) {
        return chromePath;
      }
    }

    // Try registry as fallback
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
    return path.join(app.getPath('userData'), 'chrome-profile');
  }

  /**
   * Launch Chrome with remote debugging enabled.
   */
  async launch(): Promise<void> {
    if (this.chromeProcess) {
      return; // Already launched
    }

    const chromePath = this.findChromePath();
    const userDataDir = this.getUserDataDir();

    // Ensure profile directory exists
    if (!fs.existsSync(userDataDir)) {
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

    // Wait for Chrome to start up
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  /**
   * Connect to the running Chrome instance via CDP.
   */
  async connect(): Promise<void> {
    if (this.browser) {
      return; // Already connected
    }

    this.browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${this.debugPort}`,
    });

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
  }

  /**
   * Navigate to a URL.
   */
  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  /**
   * Execute JavaScript in the page context and return the result.
   */
  async executeJS(script: string): Promise<unknown> {
    if (!this.page) {
      throw new Error('Not connected to Chrome. Call connect() first.');
    }
    return this.page.evaluate(script);
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
