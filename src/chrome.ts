import fs from "node:fs";

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/** Search platform-specific paths for a Chrome installation. */
export function findChrome(): string | null {
  const candidates = CHROME_PATHS[process.platform] ?? [];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/** Throw with install instructions if Chrome is not found. */
export function assertChromeInstalled(): void {
  if (!findChrome()) {
    throw new Error(
      "Chrome is required but was not found.\n\n" +
        "Install Google Chrome from: https://www.google.com/chrome/\n" +
        "gauge uses your system Chrome via Playwright — no bundled browser is included."
    );
  }
}
