// Records the floating Journal flow as a README GIF. No Heptabase write occurs.
// ego lite has no screen recorder, so this captures browser screenshots and
// hands the frames to ffmpeg.
// Run: ego-browser nodejs < scripts/record-demo.mjs
// Precondition: the unpacked extension is already loaded in ego lite's profile.
// Pass an output path as the first argument; defaults to assets/ next to this repo.
const GIF = process.argv[2] || new URL("../assets/side-heptabase-demo.gif", import.meta.url).pathname;
// The ego node runtime does not inherit PATH from the shell, so ffmpeg is resolved explicitly.
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";
// Requested metrics are scaled by the browser's zoom factor, so these produce a 900x600 viewport.
const VIEW = { width: 810, height: 540, deviceScaleFactor: 1, mobile: false, screenWidth: 810, screenHeight: 540 };
const PAGE_URL = "https://en.wikipedia.org/wiki/Zettelkasten";
const NOTE_PARTS = ["A useful idea", " needs a place", " to land.", "\n", "Capture now,", " connect later."];

const { copyFile, mkdtemp } = await import("node:fs/promises");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");

const FRAMES = await mkdtemp("/tmp/side-heptabase-demo-");

const task = await taskSpace("side-heptabase demo recording");
const page = task.page("p1");

let frames = 0;
let lastFrame;
async function shot() {
  lastFrame = `${FRAMES}/f${String(frames++).padStart(5, "0")}.png`;
  await page.screenshot({ path: lastFrame });
}
async function hold(count) {
  for (let i = 0; i < count; i++) {
    const next = `${FRAMES}/f${String(frames++).padStart(5, "0")}.png`;
    await copyFile(lastFrame, next);
  }
}

await page.goto(PAGE_URL);
await page.cdp("Emulation.setDeviceMetricsOverride", VIEW);
// Ego Lite briefly hides the Page between automation actions. Block that
// synthetic visibility event so the extension's transient hover UI stays open.
await page.evaluate(() => document.addEventListener("visibilitychange", (event) => event.stopImmediatePropagation(), true));
const donationBanner = await page.evaluate(() => Boolean(document.querySelector('button[aria-label="Close"]')));
if (donationBanner) await page.click('loc=role:button[name="Close"]', { label: "dismiss donation banner" });
await page.waitForSelector("#side-heptabase-root", { state: "attached", timeout: 10_000 });
await page.waitForFunction(() => {
  const root = document.getElementById("side-heptabase-root");
  return root?.shadowRoot?.querySelector(".capture[data-hidden='false']");
}, undefined, { timeout: 10_000 });

await shot();
await hold(7);
await page.hover(".utility-shell", { label: "hover the dock" });
await page.waitForFunction(() => {
  const dock = document.getElementById("side-heptabase-root")?.shadowRoot?.querySelector(".dock");
  return dock && Number(getComputedStyle(dock).opacity) > 0.95;
}, undefined, { timeout: 5_000 });
await shot();
await hold(6);
await page.hover(".dock .action[data-mode=journal]", { label: "preview journal" });
await page.waitForFunction(() => {
  const sheet = document.getElementById("side-heptabase-root")?.shadowRoot?.querySelector(".sheet");
  return sheet && Number(getComputedStyle(sheet).opacity) > 0.95;
}, undefined, { timeout: 5_000 });
await shot();
await hold(7);
await page.click(".dock .action[data-mode=journal]", { label: "pin journal composer" });
await page.waitForFunction(() => document.getElementById("side-heptabase-root")?.shadowRoot?.querySelector("[data-mode=journal][aria-pressed=true]"), undefined, { timeout: 5_000 });
await shot();
await hold(4);

for (const part of NOTE_PARTS) {
  if (part === "\n") await page.keyboard.press("Enter");
  else await page.keyboard.insertText(part);
  await shot();
  await hold(2);
}

await hold(13);

const ffmpeg = await promisify(execFile)(FFMPEG, [
  "-y",
  "-framerate", "10",
  "-i", `${FRAMES}/f%05d.png`,
  "-vf", "scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
  "-loop", "0",
  GIF,
]);

console.log({ frames, space: task.spaceId, gif: GIF, frameDir: FRAMES, ffmpeg: ffmpeg.stderr.split("\n").filter((l) => /Output file/.test(l)) });
