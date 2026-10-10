/**
 * Renders the docs and README screenshots from Storybook stories, so they show the mocked fixtures instead of
 * whatever happens to be on someone's machine.
 *
 *   pnpm screenshots                 starts Storybook on a spare port, captures every shot, stops it
 *   pnpm screenshots overview review captures only the named shots
 *
 * STORYBOOK_URL reuses a Storybook that is already running; CHROME_PATH picks the Chromium to drive.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import type { Page } from "playwright-core";

interface Shot {
  /** File name under the docs' images folder, without the extension. */
  name: string;
  /** Storybook story id, e.g. "pages-overview--default". */
  story: string;
  /** Selector for content that only shows once the story's mocked data has loaded. */
  ready: string;
  /** Captures just this element instead of the viewport. */
  clip?: string;
  /** Viewport height for this shot, so a page is cut where its content ends. */
  height?: number;
  /** Interactions to run once the story is ready. */
  prepare?: (page: Page) => Promise<void>;
}

const shots: Shot[] = [
  {
    name: "overview",
    ready: "text=Waiting on you",
    story: "pages-overview--default",
  },
  {
    height: 980,
    name: "worktrees",
    ready: "text=New worktree",
    story: "pages-project--overview",
  },
  {
    height: 660,
    name: "task-variants",
    ready: "text=Pick this one",
    story: "pages-project--task-compare",
  },
  {
    name: "review",
    ready: "text=MAX_BURST",
    story: "pages-checkout--review",
  },
  {
    height: 548,
    name: "forgejo-inbox",
    ready: "text=Last refreshed",
    story: "pages-forgejo--pull-requests",
  },
  {
    height: 1000,
    name: "forgejo-pull-request",
    ready: "text=Base branch",
    story: "pages-forgejo--pull-request",
  },
  {
    height: 520,
    name: "jira-tickets",
    ready: "text=1–4 of 4",
    story: "pages-jira--tickets",
  },
  {
    height: 640,
    name: "jira-ticket",
    ready: "text=Acceptance criteria",
    story: "pages-jira--ticket",
  },
  {
    height: 580,
    name: "nodes",
    ready: "text=Connection timed out",
    story: "pages-nodes--default",
  },
  {
    clip: "[role=dialog]",
    name: "new-task",
    prepare: async (page) => {
      await page
        .locator("[role=dialog] textarea")
        .fill(
          "Add a burst limit to the login rate limiter: reject more than 20 requests a minute per IP.\n\nCover it with a test in test/server/rate-limit.test.ts."
        );
      await page
        .getByRole("button", { name: "Compare with another model" })
        .click();
      await page.getByRole("combobox", { name: "Model 2" }).click();
      await page.getByRole("option", { name: "GPT-6" }).click();
    },
    ready: "[role=dialog] textarea",
    story: "components-newtaskdialog--default",
  },
  {
    clip: "[role=dialog]",
    name: "publish",
    ready: "[role=dialog]",
    story: "components-publishdialog--default",
  },
  {
    clip: "[role=dialog]",
    name: "add-project",
    prepare: async (page) => {
      await page
        .getByRole("option", { name: /design-system/u })
        .first()
        .click();
    },
    ready: "[role=dialog] [role=option]",
    story: "components-addprojectdialog--default",
  },
];

const VIEWPORT = { height: 820, width: 1440 } as const;
const PIXEL_RATIO = 2;
const WEBP_QUALITY = 90;
/** Time for fonts, mocked queries and enter animations to settle after the ready element shows up. */
const SETTLE_MS = 1500;
const STORYBOOK_PORT = 6116;
const STORYBOOK_TIMEOUT_MS = 120_000;

const imagesDir = fileURLToPath(
  new URL("../../docs/content/docs/images/", import.meta.url)
);

const waitForServer = async (url: string): Promise<void> => {
  const deadline = Date.now() + STORYBOOK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/iframe.html`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`Storybook did not start at ${url}`);
};

const startStorybook = async (): Promise<{
  url: string;
  server?: ChildProcess;
}> => {
  if (process.env.STORYBOOK_URL) {
    return { url: process.env.STORYBOOK_URL.replace(/\/$/u, "") };
  }
  const url = `http://localhost:${STORYBOOK_PORT}`;
  const server = spawn(
    "pnpm",
    [
      "exec",
      "storybook",
      "dev",
      "-p",
      String(STORYBOOK_PORT),
      "--ci",
      "--no-open",
    ],
    { stdio: "ignore" }
  );
  await waitForServer(url);
  return { server, url };
};

const capture = async (page: Page, url: string, shot: Shot): Promise<void> => {
  const viewport = { ...VIEWPORT, height: shot.height ?? VIEWPORT.height };
  await page.setViewportSize(viewport);
  await page.goto(`${url}/iframe.html?id=${shot.story}&viewMode=story`);
  // Storybook marks the body once the story rendered; before that its own loading screen is up.
  await page.locator("body.sb-show-main").waitFor({ state: "attached" });
  await page.locator(shot.ready).first().waitFor();
  await shot.prepare?.(page);
  // No hover or focus states in the docs.
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.waitForTimeout(SETTLE_MS);

  const box = shot.clip
    ? await page.locator(shot.clip).first().boundingBox()
    : { ...viewport, x: 0, y: 0 };
  if (!box) {
    throw new Error(`${shot.name}: ${shot.clip} is not visible`);
  }

  // Playwright only writes PNG and JPEG; Chromium itself can encode WebP.
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send("Page.captureScreenshot", {
    // The clip is in CSS pixels; its scale sets the output's pixel density.
    clip: { ...box, scale: PIXEL_RATIO },
    format: "webp",
    quality: WEBP_QUALITY,
  });
  await cdp.detach();

  const file = `${imagesDir}${shot.name}.webp`;
  await writeFile(file, Buffer.from(data, "base64"));
  console.log(`wrote ${file}`);
};

const main = async (): Promise<void> => {
  const only = process.argv.slice(2);
  const selected = only.length
    ? shots.filter((shot) => only.includes(shot.name))
    : shots;
  if (selected.length === 0) {
    throw new Error(
      `No shot named ${only.join(", ")}; pick from ${shots.map((s) => s.name).join(", ")}`
    );
  }

  const { server, url } = await startStorybook();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
  });
  try {
    const page = await browser.newPage({
      colorScheme: "dark",
      deviceScaleFactor: PIXEL_RATIO,
      reducedMotion: "reduce",
      viewport: VIEWPORT,
    });
    for (const shot of selected) {
      await capture(page, url, shot);
    }
  } finally {
    await browser.close();
    server?.kill();
  }
};

await main();
