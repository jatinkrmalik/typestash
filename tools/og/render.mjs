// Render the Open Graph cards from og.html into site/og/.
// Needs Playwright: `npx -y playwright@1 install chromium` once, then
//   node tools/og/render.mjs [demo-family-count]
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../site/og");
fs.mkdirSync(out, { recursive: true });
const count = process.argv[2] || "445";
const page = pathToFileURL(path.join(here, "og.html")).href;

const browser = await chromium.launch();
const tab = await (await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })).newPage();
for (const [v, file] of [["site", "typestash.png"], ["demo", "demo.png"]]) {
  await tab.goto(`${page}?v=${v}&n=${count}`);
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await tab.screenshot({ path: path.join(out, file) });
  console.log("wrote", path.join(out, file));
}
await browser.close();
