import { defineConfig, devices } from '@playwright/test';

const testPort = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const testOrigin = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: {
    baseURL: testOrigin,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'] } },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      grep: /phone-sized authoring/,
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${testPort}`,
    url: testOrigin,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
