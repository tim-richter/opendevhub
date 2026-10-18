import { spawn, execSync } from "node:child_process";

import { chromium } from "playwright-core";

const T = process.argv[2];
const env = {
  ...process.env,
  XDG_CONFIG_HOME: `${T}/cfg`,
  XDG_STATE_HOME: `${T}/state`,
};
const start = () =>
  spawn("node", ["dist/bin.js", "--no-open", "--port", "7791"], {
    env,
    stdio: "ignore",
  });
const up = async () => {
  for (;;) {
    try {
      if ((await fetch("http://localhost:7791/api/health")).ok) {
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
};
let server = start();
await up();
const browser = await chromium.launch({
  executablePath: execSync("which google-chrome").toString().trim(),
});
const page = await browser.newPage();
await page.goto("http://localhost:7791/");
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
console.log(
  "controlled:",
  await page.evaluate(() => !!navigator.serviceWorker.controller)
);
server.kill("SIGTERM");
await new Promise((r) => server.once("exit", r));
await page.goto("http://localhost:7791/settings");
console.log("down:", await page.title(), page.url());
await page.screenshot({ path: `${T}/offline.png` });
server = start();
await page.waitForFunction(
  () => document.title !== "opendevhub isn't running",
  null,
  { timeout: 30_000 }
);
console.log("back:", await page.title(), page.url());
await browser.close();
server.kill("SIGTERM");
