// End-to-end browser test of a running Typestash server, covering every feature.
// Usually started by run.mjs, which sets up the fonts and a throwaway server.
// Direct use (for example against a container): node e2e.mjs <base-url> <uploads-dir>
// The server's library must contain tests/e2e/fonts.txt, and nothing from uploads.txt.
// It changes favourites, notes, collections and uploads: never point it at a real library.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] || "http://127.0.0.1:8099").replace(/\/$/, "") + "/";
const UP = process.argv[3];
const results = [];
let section = "";
const ok = (name, cond, info = "") => { results.push({ section, name, pass: !!cond, info }); console.log(`${cond ? "  ✓" : "  ✗"} ${section} › ${name}${info ? `  (${info})` : ""}`); };
const sec = (s) => { section = s; console.log(`\n${s}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (p, opts) => { const r = await fetch(BASE + p.replace(/^\//, ""), opts); return r.headers.get("content-type")?.includes("json") ? r.json() : r; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE.replace(/\/$/, "") });
const seen = () => localStorage.setItem("tc.welcomed", "true");
await ctx.addInitScript(seen);
const page = await ctx.newPage();
const consoleErrors = [], badResponses = [];
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push("console: " + m.text()); });
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/api/upload")) badResponses.push(`${r.status()} ${r.url()}`); });
const go = async (hash, wait = 900) => { await page.goto(BASE + hash); await page.waitForTimeout(wait); };
const count = (sel) => page.locator(sel).count();
const resultN = async () => Number((await page.locator("#result-line").innerText()).match(/\d[\d,]*/)[0].replace(/,/g, ""));
const lib = () => api("/api/library");

try {
  // ---------------------------------------------------------------- server
  sec("Server");
  const hz = await fetch(BASE + "healthz"); ok("healthz responds 200", hz.status === 200);
  let L = await lib();
  for (let i = 0; i < 120 && L.scan?.scanning; i++) { await sleep(1000); L = await lib(); }
  ok("first index completes", !L.scan?.scanning, `${L.families.length} families`);
  ok("library reports a version", /^\d+\.\d+\.\d+$/.test(L.version), L.version);
  const total = L.families.length;
  ok("library has enough fonts to page", total > 48, String(total));

  // ---------------------------------------------------------------- gallery
  sec("Gallery");
  await go("#/", 1500);
  ok("cards render", (await count(".card")) >= 30, String(await count(".card")));
  await page.waitForTimeout(1500);
  const ready = await page.evaluate(() => [...document.querySelectorAll(".card .specimen")].filter((e) => e.getBoundingClientRect().top < innerHeight && e.classList.contains("ready")).length);
  ok("visible previews load their fonts", ready >= 6, `${ready} ready`);
  ok("result line shows total", (await resultN()) === total);
  ok("footer pinned at card bottom", await page.evaluate(() => {
    const rows = {}; for (const c of [...document.querySelectorAll(".card")].slice(0, 6)) { const top = Math.round(c.getBoundingClientRect().top); const f = c.querySelector(".card-foot").getBoundingClientRect(); (rows[top] ||= []).push(Math.round(c.getBoundingClientRect().bottom - f.bottom)); }
    return Object.values(rows).every((r) => r.every((d) => d === r[0]));
  }));

  await page.fill("#q", "mono"); await page.waitForTimeout(500);
  const nMono = await resultN(); ok("search filters the list", nMono > 0 && nMono < total, String(nMono));
  await page.fill("#q", ""); await page.waitForTimeout(400);
  ok("clearing search restores all", (await resultN()) === total);

  await page.click('[data-cat="serif"]'); await page.waitForTimeout(500);
  const nSerif = await resultN();
  ok("category chip filters", nSerif > 0 && nSerif < total && (await count(".card:not(.c-serif)")) === 0, String(nSerif));
  await page.click('[data-cat="all"]'); await page.waitForTimeout(300);
  await page.click('[data-flag="vf"]'); await page.waitForTimeout(500);
  const nVf = await resultN();
  ok("variable filter", nVf > 0 && nVf < total && (await count('.card .tag.plain[title="Variable font"]')) === (await count(".card")), String(nVf));
  await page.click('[data-flag="vf"]'); await page.click('[data-flag="ital"]'); await page.waitForTimeout(500);
  const nIt = await resultN(); ok("italics filter", nIt > 0 && nIt < total, String(nIt));
  await page.click('[data-flag="ital"]'); await page.waitForTimeout(300);
  const scripts = await page.$$eval("#script option", (o) => o.map((x) => x.value).filter(Boolean));
  if (scripts.includes("Cyrillic")) { await page.selectOption("#script", "Cyrillic"); await page.waitForTimeout(500); const n = await resultN(); ok("script filter (Cyrillic)", n > 0 && n < total, String(n)); await page.selectOption("#script", ""); await page.waitForTimeout(300); }
  else ok("script filter has options", scripts.length > 0, scripts.join(","));

  const firstNames = async () => page.$$eval(".card .fname", (e) => e.slice(0, 5).map((x) => x.textContent).join("|"));
  await page.selectOption("#sort", "az"); await page.waitForTimeout(300); const az = await firstNames();
  ok("A→Z sort is alphabetical", await page.$$eval(".card .fname", (e) => { const n = e.slice(0, 20).map((x) => x.textContent); return n.every((v, i) => !i || n[i - 1].localeCompare(v) <= 0); }));
  for (const s of ["new", "styles", "shuffle"]) { await page.selectOption("#sort", s); await page.waitForTimeout(300); ok(`sort “${s}” reorders`, (await firstNames()) !== az); }
  await page.selectOption("#sort", "az"); await page.waitForTimeout(300);

  await page.click('[data-view="list"]'); await page.waitForTimeout(300);
  ok("list view", await page.locator("#grid.list, .grid.list").count() === 1);
  await page.click('[data-view="grid"]'); await page.waitForTimeout(300);
  ok("grid view", await page.locator(".grid.list").count() === 0);

  await page.locator("#size").evaluate((el) => { el.value = 72; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(300);
  ok("size slider resizes previews", await page.locator(".card .specimen").first().evaluate((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))) === 72);
  await page.locator("#size").evaluate((el) => { el.value = 44; el.dispatchEvent(new Event("input", { bubbles: true })); });

  await page.fill("#sample", "Typestash e2e"); await page.waitForTimeout(400);
  ok("custom preview text", (await page.locator(".card .specimen").first().innerText()).includes("Typestash e2e"));
  await page.click('[data-preset="b1"]'); await page.waitForTimeout(300);
  const pre1 = await page.inputValue("#sample");
  ok("built-in preset applies", pre1 !== "Typestash e2e", pre1.slice(0, 30));
  await page.click('[data-act="scriptmenu"]'); await page.waitForTimeout(300);
  const scriptItems = await page.locator("#menu button").count();
  ok("Scripts menu opens", scriptItems > 2, `${scriptItems} items`);
  const greek = page.locator('#menu button:has-text("Greek")');
  if (await greek.count()) { await greek.first().click(); await page.waitForTimeout(500); ok("Greek script preview", /[Ͱ-Ͽ]/.test(await page.locator(".card .specimen").first().innerText())); }
  ok("script preview also filters to fonts that support it", (await page.inputValue("#script")) === "Greek" && (await resultN()) < total);
  await page.selectOption("#script", ""); await page.fill("#sample", ""); await page.waitForTimeout(400);

  const before = await count(".card");
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(1200);
  ok("infinite scroll loads more", (await count(".card")) > before, `${before} → ${await count(".card")}`);
  await page.evaluate(() => scrollTo(0, 0));

  // card actions
  const card = page.locator(".card").first(); const key = await card.getAttribute("data-key");
  const fav0 = (await lib()).families.find((f) => f.key === key)?.favorite;
  if (fav0) { await card.hover(); await card.locator('[data-act="fav"]').click(); await page.waitForTimeout(500); }
  await card.hover(); await card.locator('[data-act="fav"]').click(); await page.waitForTimeout(500);
  ok("favourite from card", (await lib()).families.find((f) => f.key === key)?.favorite === true, key);
  await card.locator('[data-act="pick"]').click(); await page.waitForTimeout(300);
  ok("add to compare from card", (await page.evaluate(() => JSON.parse(localStorage.getItem("tc.picks") || "[]"))).includes(key));
  const href = await card.locator('[data-act="dl"]').getAttribute("href");
  const zr = await fetch(BASE + href); const zb = Buffer.from(await zr.arrayBuffer());
  ok("card download is a zip", zr.status === 200 && zb.subarray(0, 2).toString() === "PK", `${zb.length} bytes`);
  await card.locator('[data-act="more"]').click(); await page.waitForTimeout(300);
  const menuText = await page.locator("#menu").innerText();
  ok("card menu opens", menuText.includes("Download family") && /category/i.test(menuText) && /collections/i.test(menuText));
  await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- favourites / recent / surprise
  sec("Library views");
  await go("#/fav"); ok("Favourites view lists the font", (await count(`.card[data-key="${key}"]`)) === 1);
  await go("#/recent"); ok("Recently added view", (await count(".card")) > 0);
  await go("#/"); await page.click("#surprise-btn"); await page.waitForTimeout(900);
  ok("Surprise me opens a family", page.url().includes("#/f/"), page.url().split("#")[1]);
  await go("#/"); await page.click('#side .nav[data-act="surprise"]'); await page.waitForTimeout(900);
  ok("sidebar Surprise me", page.url().includes("#/f/"));

  // ---------------------------------------------------------------- family page
  sec("Family page");
  await go("#/f/fraunces", 1800);
  ok("title", (await page.locator("h1").innerText()).trim() === "Fraunces");
  ok("variable axes listed", (await count("[data-axis]")) >= 2, String(await count("[data-axis]")));
  await page.locator('[data-axis="wght"]').evaluate((el) => { el.value = 300; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(200);
  ok("axis slider drives the tester", (await page.locator("#t-area").evaluate((e) => getComputedStyle(e).fontVariationSettings)).includes("300"));
  await page.click('[data-act="axanim"]'); await page.waitForTimeout(800);
  const v1 = await page.locator("#t-area").evaluate((e) => getComputedStyle(e).fontVariationSettings); await page.waitForTimeout(500);
  const v2 = await page.locator("#t-area").evaluate((e) => getComputedStyle(e).fontVariationSettings);
  ok("Animate moves the axes", v1 !== v2); await page.click('[data-act="axanim"]');
  if (await count('[data-feat="ss01"]')) { await page.click('[data-feat="ss01"]'); await page.waitForTimeout(200); ok("OpenType feature toggle", (await page.locator("#t-area").evaluate((e) => getComputedStyle(e).fontFeatureSettings)).includes("ss01")); }
  await page.locator("#t-size").evaluate((el) => { el.value = 90; el.dispatchEvent(new Event("input", { bubbles: true })); });
  ok("tester size", await page.locator("#t-area").evaluate((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))) === 90);
  ok("styles list", (await count("#styles .style-row")) >= 2, String(await count("#styles .style-row")));
  ok("waterfall", (await page.locator("#waterfall").innerText()).length > 20);
  ok("glyph grid", (await count("#g-grid button")) > 50, String(await count("#g-grid button")));
  await page.click('#g-grid button[data-cp="65"]'); await page.waitForTimeout(200);
  ok("glyph inspector", (await page.locator("#g-insp").innerText()).includes("0041"));
  await page.locator('#g-grid button[data-cp="66"]').dblclick(); await page.waitForTimeout(300);
  ok("double-click copies glyph", (await page.evaluate(() => navigator.clipboard.readText().catch(() => ""))) === "B");
  if (await count("#g-q")) { await page.fill("#g-q", "z"); await page.waitForTimeout(300); ok("glyph search", (await count("#g-grid button")) >= 1 && (await count("#g-grid button")) < 20); await page.fill("#g-q", ""); }
  const pairBefore = await page.locator("#p-body").innerHTML();
  await page.click('[data-act="pairshuffle"]'); await page.waitForTimeout(400);
  ok("pairing shuffle", (await page.locator("#p-body").innerHTML()) !== pairBefore);
  const ff0 = (await lib()).families.find((f) => f.key === "fraunces")?.favorite;
  await page.click('[data-act="famfav"]'); await page.waitForTimeout(500);
  ok("favourite toggle on family page", (await lib()).families.find((f) => f.key === "fraunces")?.favorite === !ff0);
  await page.fill("#note", "E2E note: from the test suite"); await page.locator("#note").blur(); await page.waitForTimeout(1200);
  ok("notes save", ((await api("/api/family/fraunces")).note || "").includes("E2E note"));
  // collection via the Collections button
  await page.click('[data-act="fammore"]'); await page.waitForTimeout(300);
  await page.locator('#menu button:has-text("New collection")').click(); await page.waitForTimeout(300);
  await page.keyboard.type("E2E collection"); await page.keyboard.press("Enter"); await page.waitForTimeout(900);
  let coll = (await lib()).collections.find((c) => c.name === "E2E collection");
  ok("create collection with this font", coll && coll.count === 1);
  // specimen PNG
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click('[data-act="specimen"]')]);
  const pngPath = await dl.path(); const png = fs.readFileSync(pngPath);
  ok("specimen PNG downloads", png.subarray(1, 4).toString() === "PNG" && png.length > 20000, `${dl.suggestedFilename()} ${Math.round(png.length / 1024)} KB`);
  const fam = await api("/api/family/fraunces");
  const sr = await fetch(BASE + "download/" + fam.faces[0].id);
  ok("single style download", sr.status === 200 && (await sr.arrayBuffer()).byteLength > 10000);
  const fr = await fetch(BASE + "font/" + fam.faces[0].id); ok("font file served for previews", fr.status === 200);
  // category override from the card menu
  await go("#/"); await page.fill("#q", "fraunces"); await page.waitForTimeout(500);
  await page.locator('.card[data-key="fraunces"]').hover(); await page.locator('.card[data-key="fraunces"] [data-act="more"]').click();
  await page.locator('#menu button:has-text("Display")').click(); await page.waitForTimeout(700);
  ok("category override", (await lib()).families.find((f) => f.key === "fraunces")?.category === "display");
  await page.locator('.card[data-key="fraunces"]').hover(); await page.locator('.card[data-key="fraunces"] [data-act="more"]').click();
  await page.locator('#menu button:has-text("Serif")').click(); await page.waitForTimeout(700);
  ok("category back to auto", (await lib()).families.find((f) => f.key === "fraunces")?.category === "serif");
  await page.fill("#q", "");

  // ---------------------------------------------------------------- collections
  sec("Collections");
  coll = (await lib()).collections.find((c) => c.name === "E2E collection");
  await go(`#/c/${coll.id}`);
  ok("collection page lists its fonts", (await count(".card")) === 1);
  const cz = await fetch(BASE + `download/collection/${coll.id}`); const czb = Buffer.from(await cz.arrayBuffer());
  ok("collection zip", cz.status === 200 && czb.subarray(0, 2).toString() === "PK");
  await page.click('[data-act="renamecoll"]'); await page.waitForTimeout(300);
  await page.keyboard.press("Control+A"); await page.keyboard.type("E2E renamed"); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
  ok("rename collection", (await lib()).collections.some((c) => c.name === "E2E renamed"));
  await page.click('[data-act="delcoll"]'); await page.waitForTimeout(300);
  await page.keyboard.type("DELETE"); await page.keyboard.press("Enter"); await page.waitForTimeout(900);
  ok("delete collection (fonts kept)", !(await lib()).collections.some((c) => c.id === coll.id) && (await lib()).families.length >= total);

  // ---------------------------------------------------------------- compare
  sec("Compare");
  await page.evaluate(() => localStorage.setItem("tc.picks", JSON.stringify(["playfair-display", "inter", "jetbrains-mono", "caveat"])));
  await go("#/compare", 300); await page.reload(); await page.waitForTimeout(1500);
  ok("columns view shows picks", (await page.locator("#cmp-body").innerText()).includes("Caveat") && (await count("[data-cmp-move]")) === 8);
  await page.locator("#c-weight").evaluate((el) => { el.value = 700; el.dispatchEvent(new Event("input", { bubbles: true })); }); await page.waitForTimeout(300);
  ok("weight slider", (await page.locator("#c-weight-v").innerText()).includes("700"));
  await page.locator("#c-size").evaluate((el) => { el.value = 60; el.dispatchEvent(new Event("input", { bubbles: true })); }); await page.waitForTimeout(200);
  ok("size slider", (await page.locator("#c-size-v").innerText()).includes("60"));
  await page.fill("#c-text", "Compare me"); await page.waitForTimeout(300);
  ok("custom compare text", (await page.locator("#cmp-body").innerText()).includes("Compare me"));
  await page.locator('[data-cmp-move="1"]').first().click(); await page.waitForTimeout(300);
  ok("reorder", JSON.parse(await page.evaluate(() => localStorage.getItem("tc.picks")))[0] === "inter");
  for (const v of ["rows", "overlay", "cols"]) { await page.click(`[data-cmp-view="${v}"]`); await page.waitForTimeout(400); ok(`view: ${v}`, (await page.locator(`[data-cmp-view="${v}"].on`).count()) === 1 && (await page.locator("#cmp-body").innerText()).length > 20); }
  await page.click('[data-cmp-view="overlay"]'); await page.waitForTimeout(300);
  await page.locator('[data-cmp-layer="1"]').click(); await page.waitForTimeout(200);
  ok("overlay layer toggle", (await page.locator('[data-cmp-layer="1"].on').count()) === 0);
  await page.click('[data-cmp-view="cols"]');
  await page.locator('.cmp-add[data-act="cmpadd"], [data-act="cmpadd"]').first().click(); await page.waitForTimeout(400);
  ok("Add opens the picker", await page.locator("#palette").isVisible());
  await page.keyboard.type("lobster"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(600);
  ok("add a fifth font", JSON.parse(await page.evaluate(() => localStorage.getItem("tc.picks"))).length === 5);
  await page.locator('[data-act="clearpicks"]').first().click(); await page.waitForTimeout(400);
  ok("clear", JSON.parse(await page.evaluate(() => localStorage.getItem("tc.picks"))).length === 0);

  // ---------------------------------------------------------------- command bar + keyboard
  sec("Command bar & keyboard");
  await go("#/");
  await page.keyboard.press("Control+K"); await page.waitForTimeout(300);
  ok("Ctrl+K opens the command bar", await page.locator("#palette").isVisible());
  await page.keyboard.type("caveat"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(800);
  ok("jump to a font", page.url().endsWith("#/f/caveat"));
  await page.keyboard.press("Control+K"); await page.keyboard.type("dracula"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
  ok("switch theme from the command bar", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dracula");
  await page.keyboard.press("Control+K"); await page.keyboard.type("settings"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(600);
  ok("open settings from the command bar", page.url().endsWith("#/settings"));
  await go("#/");
  await page.keyboard.press("Control+K"); await page.keyboard.type("serif"); await page.waitForTimeout(300);
  ok("command bar lists filters too", (await page.locator("#palette-list").innerText()).toLowerCase().includes("serif"));
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  ok("Escape closes it", !(await page.locator("#palette").isVisible()));
  await page.keyboard.press("/"); ok("/ focuses search", await page.evaluate(() => document.activeElement?.id === "q"));
  await page.locator("#q").blur();
  const m0 = await page.evaluate(() => document.documentElement.dataset.mode);
  await page.keyboard.press("d"); await page.waitForTimeout(200);
  ok("d toggles light/dark", (await page.evaluate(() => document.documentElement.dataset.mode)) !== m0);
  await page.keyboard.press("d");
  await page.keyboard.press("["); await page.waitForTimeout(400);
  ok("[ collapses the sidebar", await page.locator(".layout.side-collapsed").count() === 1);
  await page.keyboard.press("["); await page.waitForTimeout(300);
  await page.keyboard.press(","); await page.waitForTimeout(500); ok(", opens settings", page.url().endsWith("#/settings"));

  // ---------------------------------------------------------------- themes
  sec("Themes");
  await go("#/"); await page.keyboard.press("Control+K"); await page.keyboard.type("choose theme"); await page.waitForTimeout(300); await page.keyboard.press("Enter"); await page.waitForTimeout(500);
  ok("theme panel opens", await page.locator("#theme-panel").isVisible());
  const ids = await page.$$eval("#theme-panel [data-theme-pick]", (b) => b.map((x) => x.dataset.themePick));
  ok("12 themes", ids.length === 12, ids.join(","));
  let applied = 0;
  for (const id of ids) { await page.click(`#theme-panel [data-theme-pick="${id}"]`); await page.waitForTimeout(120); if ((await page.evaluate(() => document.documentElement.dataset.theme)) === id) applied++; }
  ok("every theme applies", applied === ids.length, `${applied}/${ids.length}`);
  await page.locator("#theme-panel [data-theme-auto]").check(); await page.waitForTimeout(200);
  ok("Match system", (await page.evaluate(() => localStorage.getItem("tc.themeMode"))).includes("auto"));
  await page.locator("#theme-panel [data-theme-auto]").uncheck();
  await page.click('#theme-panel [data-theme-pick="paper"]'); await page.keyboard.press("Escape");

  // ---------------------------------------------------------------- settings
  sec("Settings");
  await go("#/settings");
  ok("server info shows the version", (await page.locator("#view").innerText()).includes(L.version));
  await page.locator("#set-size").evaluate((el) => { el.value = 60; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  ok("default preview size saves", (await page.evaluate(() => localStorage.getItem("tc.size"))) === "60");
  await page.fill("#set-text", "Settings sample"); await page.locator("#set-text").blur(); await page.waitForTimeout(300);
  ok("default preview text saves", (await page.evaluate(() => localStorage.getItem("tc.text") || "")).includes("Settings sample"));
  await page.selectOption("#set-sort", "new"); await page.waitForTimeout(200);
  ok("default sort saves", (await page.evaluate(() => localStorage.getItem("tc.sort"))).includes("new"));
  await page.click('[data-act="addpreset"]'); await page.waitForTimeout(300);
  ok("add preset row", (await count(".preset-row")) >= 1);
  const row = page.locator(".preset-row").last();
  await row.locator(".pre-label").fill("E2E"); await row.locator(".pre-text").fill("Preset from the test"); await row.locator(".pre-text").blur(); await page.waitForTimeout(400);
  await go("#/");
  const custom = page.locator(".pre-custom", { hasText: "E2E" });
  ok("custom preset appears next to preview text", (await custom.count()) === 1);
  if (await custom.count()) { await custom.click(); await page.waitForTimeout(300); ok("custom preset applies", (await page.inputValue("#sample")) === "Preset from the test"); }
  await go("#/settings"); await page.locator('.preset-row [data-act="delpreset"]').last().click(); await page.waitForTimeout(300);
  ok("delete preset", (await count(".preset-row")) === 0);
  ok("keyboard shortcuts listed", (await page.locator("#view").innerText()).includes("Command bar"));
  await page.click('[data-act="resetprefs"]'); await page.waitForTimeout(400);
  const dlg = await page.locator(".palette input").count();
  if (dlg) { await page.keyboard.type("RESET"); await page.keyboard.press("Enter"); await page.waitForTimeout(600); }
  ok("reset preferences", !(await page.evaluate(() => localStorage.getItem("tc.text"))), dlg ? "via confirm box" : "");

  // ---------------------------------------------------------------- health, rescan
  sec("Housekeeping");
  await go("#/health");
  const dups = await api("/api/duplicates");
  ok("Duplicates & issues page", (await page.locator("h1").innerText()).toLowerCase().includes("duplicate") && dups !== null);
  await go("#/");
  await page.click('[data-act="rescan"]'); await page.waitForTimeout(500);
  let sc = await api("/api/scan"); for (let i = 0; i < 60 && sc.scanning; i++) { await sleep(1000); sc = await api("/api/scan"); }
  ok("Rescan completes", !sc.scanning, `${sc.done}/${sc.total}`);

  // ---------------------------------------------------------------- upload
  sec("Upload");
  if (UP) {
    const n0 = (await lib()).families.length;
    await go("#/");
    await page.setInputFiles("#file-input", path.join(UP, "YoungSerif-Regular.ttf"));
    await page.waitForTimeout(2500);
    let L2 = await lib(); ok("file picker upload adds a family", L2.families.some((f) => f.name === "Young Serif"), `${n0} → ${L2.families.length}`);
    ok("upload toast shows", (await page.locator(".toast").last().innerText()).length > 0, (await page.locator(".toast").last().innerText()).replace(/s+/g, " ").slice(0, 60));
    // drag and drop
    const b64 = fs.readFileSync(path.join(UP, "Zeyada.ttf")).toString("base64");
    await page.evaluate(async (b) => {
      const bin = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], "Zeyada.ttf", { type: "font/ttf" }));
      dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForTimeout(2500);
    L2 = await lib(); ok("drag and drop upload", L2.families.some((f) => f.name === "Zeyada"));
    await page.setInputFiles("#file-input", path.join(UP, "yellowtail.zip")); await page.waitForTimeout(2500);
    L2 = await lib(); ok("zip upload", L2.families.some((f) => f.name === "Yellowtail"));
    const nBefore = L2.families.length;
    await page.setInputFiles("#file-input", path.join(UP, "YoungSerif-Regular.ttf")); await page.waitForTimeout(2000);
    const dupToast = await page.locator(".toast").last().innerText();
    ok("duplicate upload is skipped", (await lib()).families.length === nBefore, dupToast.replace(/\s+/g, " ").slice(0, 60));
    await page.setInputFiles("#file-input", path.join(UP, "notafont.ttf")); await page.waitForTimeout(2000);
    const badToast = await page.locator(".toast").last().innerText();
    ok("invalid file is rejected", (await lib()).families.length === nBefore, badToast.replace(/\s+/g, " ").slice(0, 60));
    const yf = (await lib()).families.find((f) => f.name === "Young Serif");
    ok("uploads filed under Uploads/<Family>", (await api("/api/family/" + yf.key)).faces.some((x) => (x.path || "").replace(/\\/g, "/").startsWith("Uploads/Young Serif/")));
  } else ok("uploads dir given", false, "skipped");

  // ---------------------------------------------------------------- phone layout
  sec("Phone layout");
  const phCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await phCtx.addInitScript(seen);
  const ph = await phCtx.newPage();
  ph.on("pageerror", (e) => consoleErrors.push("phone: " + e.message));
  await ph.goto(BASE + "#/"); await ph.waitForTimeout(1500);
  ok("no sideways scroll", !(await ph.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await ph.tap("#side-btn"); await ph.waitForTimeout(400);
  ok("menu drawer opens", await ph.locator(".layout.drawer-open").count() === 1);
  await ph.tap('.side a[href="#/fav"]'); await ph.waitForTimeout(600);
  ok("drawer link navigates and closes", ph.url().endsWith("#/fav") && (await ph.locator(".layout.drawer-open").count()) === 0);
  await ph.goto(BASE + "#/f/fraunces"); await ph.waitForTimeout(1500);
  ok("family page on phone", !(await ph.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  const foldCtx = await browser.newContext({ viewport: { width: 840, height: 900 } });
  await foldCtx.addInitScript(seen);
  const fold = await foldCtx.newPage();
  await fold.goto(BASE + "#/"); await fold.waitForTimeout(1200);
  ok("foldable width keeps the sidebar", await fold.locator(".side").evaluate((e) => e.getBoundingClientRect().left === 0 && getComputedStyle(e).position !== "fixed"));

  // ---------------------------------------------------------------- welcome tour
  sec("Welcome tour");
  const tp = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  tp.on("pageerror", (e) => consoleErrors.push("tour: " + e.message));
  await tp.goto(BASE + "#/"); await tp.waitForTimeout(2200);
  ok("shows on a first visit", await tp.locator(".tour-card.tour-hero").isVisible(), await tp.locator(".tour-card h3").innerText().catch(() => ""));
  ok("animated wordmark settles", (await tp.locator(".tour-mark.done").count()) === 1 || (await tp.waitForTimeout(1500), (await tp.locator(".tour-mark.done").count()) === 1));
  await tp.click("[data-tour=next]"); await tp.waitForTimeout(300);
  let stepsSeen = 1;
  while ((await tp.locator("[data-tour=next]").count()) && stepsSeen < 10) { await tp.click("[data-tour=next]"); await tp.waitForTimeout(250); stepsSeen++; }
  ok("walks through every step", (await tp.locator("button[data-tour=done]").count()) === 1, `${stepsSeen + 1} steps`);
  await tp.keyboard.press("Escape"); await tp.waitForTimeout(300);
  ok("Esc closes it and says how to reopen", (await tp.locator("#tour").count()) === 0 && /reopen/i.test(await tp.locator(".toast").last().innerText()));
  await tp.reload(); await tp.waitForTimeout(2200);
  ok("never comes back on its own", (await tp.locator("#tour").count()) === 0);
  await tp.goto(BASE + "#/settings"); await tp.waitForTimeout(600);
  await tp.click('[data-act="tour"]'); await tp.waitForTimeout(800);
  ok("Settings replays it", await tp.locator(".tour-card.tour-hero").isVisible() && tp.url().endsWith("#/"));
  await tp.click("[data-tour=skip]"); await tp.waitForTimeout(200);
  await tp.keyboard.press("Control+K"); await tp.keyboard.type("welcome tour"); await tp.waitForTimeout(300); await tp.keyboard.press("Enter"); await tp.waitForTimeout(700);
  ok("command bar replays it", await tp.locator(".tour-card").isVisible());

  // ---------------------------------------------------------------- footer
  sec("Footer & links");
  await go("#/");
  const foot = await page.locator("footer, .site-foot").last().innerText();
  ok("footer shows version and stats", foot.includes(L.version) && /\d/.test(foot));
  const links = await page.$$eval("footer a[href^='http'], .site-foot a[href^='http']", (a) => a.map((x) => x.href));
  ok("footer links present", links.length >= 4, links.length + " links");
} catch (e) {
  ok("suite ran without crashing", false, e.message.split("\n")[0]);
}

sec("Errors");
ok("no JavaScript errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
ok("no failed requests", badResponses.length === 0, badResponses.slice(0, 5).join(" | "));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log("FAILED:"); for (const f of failed) console.log(` - ${f.section} › ${f.name} ${f.info}`); }
fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "results.json"), JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
