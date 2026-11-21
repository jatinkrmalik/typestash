/* Typestash front end: no framework, no build step. */
"use strict";

const APP_NAME = "Typestash";

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const enc = encodeURIComponent;
const plural = (n, w) => `${n.toLocaleString()} ${n === 1 ? w : w.endsWith("y") ? w.slice(0, -1) + "ies" : w + "s"}`;
const fmtBytes = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k, d) { try { const v = localStorage.getItem("tc." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tc." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// Demo mode (GitHub Pages): a static snapshot under demo/, with favourites,
// notes and collections kept in this browser's localStorage.
const DEMO = window.TYPESTASH_DEMO || null;
const REPO = (DEMO && DEMO.repo) || "https://github.com/jatinkrmalik/typestash";
const U = {
  font: (id) => DEMO ? `demo/fonts/${id}` : `font/${id}`,
  face: (id) => DEMO ? `demo/fonts/${id}` : `download/${id}`,
  family: (key) => DEMO ? `demo/zip/${enc(key)}.zip` : `download/family/${enc(key)}`,
  collection: (id) => DEMO ? null : `download/collection/${id}`,
};
const fileName = (path) => String(path).split("/").pop();
let DS = null;
const demoCache = new Map();
function demoGet(file) {
  if (!demoCache.has(file)) {
    demoCache.set(file, fetch(`demo/${file}`).then((r) => { if (!r.ok) throw new Error("not found"); return r.json(); }));
  }
  return demoCache.get(file);
}
function demoSave() { store.set("demo", DS); }
function demoOverlay(f) {
  return {
    ...f, favorite: DS.fav.includes(f.key), note: DS.notes[f.key] || "",
    category: DS.cats[f.key] || f.category_auto,
    collections: DS.colls.filter((c) => c.fonts.includes(f.key)).map((c) => c.id),
  };
}
async function demoApi(path, opts) {
  DS = DS || store.get("demo", null) || {
    fav: ["fraunces", "bricolage-grotesque", "instrument-serif"], notes: {}, cats: {}, next: 3,
    colls: [{ id: 1, name: "Wedding invite", fonts: ["playfair-display", "dancing-script", "cormorant-garamond"] },
      { id: 2, name: "Dev blog", fonts: ["jetbrains-mono", "inter", "space-grotesk"] }],
  };
  const p = path.replace(/^\/?api\//, "").split("/").map(decodeURIComponent);
  const body = opts.json || {};
  const method = opts.method || (opts.json !== undefined ? "POST" : "GET");
  if (method === "GET") {
    if (p[0] === "library") {
      const lib = structuredClone(await demoGet("library.json"));
      lib.families = lib.families.map(demoOverlay);
      lib.collections = DS.colls.map((c) => ({ id: c.id, name: c.name, color: "", count: c.fonts.length }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return lib;
    }
    if (p[0] === "family") return demoOverlay(structuredClone(await demoGet(`family/${p[1]}.json`)));
    if (p[0] === "face") return demoGet(`chars/${p[1]}.json`);
    if (p[0] === "duplicates") return [];
    if (p[0] === "scan") return (await demoGet("library.json")).scan;
  }
  if (p[0] === "favorite") {
    const i = DS.fav.indexOf(p[1]);
    if (i >= 0) DS.fav.splice(i, 1); else DS.fav.push(p[1]);
    demoSave();
    return { favorite: i < 0 };
  }
  if (p[0] === "note") {
    const n = String(body.note || "").trim();
    if (n) DS.notes[p[1]] = n; else delete DS.notes[p[1]];
    demoSave();
    return { note: n };
  }
  if (p[0] === "category") {
    if (body.category) DS.cats[p[1]] = body.category; else delete DS.cats[p[1]];
    demoSave();
    return { category: body.category || null };
  }
  if (p[0] === "collections" && p.length === 1) {
    const name = String(body.name || "").trim().slice(0, 80);
    let c = DS.colls.find((x) => x.name === name);
    if (!c) { c = { id: DS.next++, name, fonts: [] }; DS.colls.push(c); }
    (body.fonts || []).forEach((k) => { if (!c.fonts.includes(k)) c.fonts.push(k); });
    demoSave();
    return { id: c.id, name: c.name };
  }
  if (p[0] === "collections") {
    const c = DS.colls.find((x) => x.id === Number(p[1]));
    if (!c) throw new Error("not found");
    if (p[2] === "delete") { DS.colls = DS.colls.filter((x) => x !== c); demoSave(); return { ok: true }; }
    if (p[2] === "rename") {
      if (DS.colls.some((x) => x.name === body.name && x !== c)) throw new Error("name taken");
      c.name = String(body.name).slice(0, 80); demoSave(); return { ok: true };
    }
    if (p[2] === "toggle") {
      const i = c.fonts.indexOf(p[3]);
      if (i >= 0) c.fonts.splice(i, 1); else c.fonts.push(p[3]);
      demoSave();
      return { member: i < 0 };
    }
  }
  throw new Error("Not available in the demo");
}
function demoReadOnly() {
  toast(`This is a read-only demo. <a href="${REPO}" target="_blank" rel="noopener">Self-host Typestash</a> to add your own fonts.`, { raw: true });
}

async function api(path, opts = {}) {
  if (DEMO) return demoApi(path, opts);
  path = path.replace(/^\//, "");
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  }
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

const ICON = {
  heart: '<svg class="i" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9.2-8.6C1.2 8.2 3 4.5 6.6 4.5c2.1 0 3.5 1.2 4.4 2.6.9-1.4 2.3-2.6 4.4-2.6 3.6 0 5.4 3.7 3.8 6.9C19 15.6 12 20 12 20z"/></svg>',
  more: '<svg class="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
  download: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/></svg>',
  compare: '<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/></svg>',
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>',
  grid: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
  list: '<svg class="i" viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  dice: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r=".9"/><circle cx="15" cy="15" r=".9"/><circle cx="15" cy="9" r=".9"/><circle cx="9" cy="15" r=".9"/></svg>',
  sun: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>',
  moon: '<svg class="i" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  x: '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  all: '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  clock: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>',
  folder: '<svg class="i" viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
  alert: '<svg class="i" viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.5M12 17v.3"/></svg>',
  refresh: '<svg class="i" viewBox="0 0 24 24"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>',
  image: '<svg class="i" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-5-5-8 8"/></svg>',
  copy: '<svg class="i" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5a1.5 1.5 0 0 0-1.5-1.5h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
  pen: '<svg class="i" viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16z"/></svg>',
  tag: '<svg class="i" viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8.5" cy="8.5" r="1.2"/></svg>',
  palette: '<svg class="i" viewBox="0 0 24 24"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.7-1.5h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11" r="1.1"/><circle cx="10" cy="7.3" r="1.1"/><circle cx="14.6" cy="7.4" r="1.1"/></svg>',
  gear: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 0 0 2.6-1.5l2.4 1 2-3.4z"/></svg>',
  open: '<svg class="i" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
};

const CATS = [
  ["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"], ["display", "Display"],
  ["script", "Script"], ["symbol", "Symbol"], ["other", "Unsorted"],
];
const CAT_LABEL = Object.fromEntries(CATS);
const SAMPLES = {
  sans: "Sphinx of black quartz, judge my vow",
  serif: "The quick brown fox jumps over the lazy dog",
  mono: "let fox = jump(0xC0FFEE); // 0O 1lI",
  display: "Big, bold & impossible to ignore",
  script: "Handwritten with love & a little flair",
  symbol: "ABCDEFGHIJKLM abcdefghijklm 0123456789",
  other: "Pack my box with five dozen liquor jugs",
};
const SCRIPT_SAMPLE = {
  Devanagari: "नमस्ते, यह अक्षरों का नमूना है", Bengali: "আমার সোনার বাংলা", Tamil: "யாமறிந்த மொழிகளிலே", Arabic: "نص حكيم له سر قاطع",
  Hebrew: "דג סקרן שט בים מאוכזב", Thai: "เป็นมนุษย์สุดประเสริฐเลิศคุณค่า", CJK: "永和九年，岁在癸丑", Kana: "いろはにほへと ちりぬるを",
  Hangul: "다람쥐 헌 쳇바퀴에 타고파", Greek: "Ξεσκεπάζω την ψυχοφθόρα βδελυγμία", Cyrillic: "Съешь же ещё этих мягких французских булок",
};
const PRESETS = [
  ["Pangram", ""], ["Aa", "Aa Gg Rr"], ["ABC", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"], ["abc", "abcdefghijklmnopqrstuvwxyz"],
  ["123", "0123456789 $€£₹ %&@#?!"], ["हिन्दी", "नमस्ते दुनिया"],
];
const FEATURE_NAMES = {
  liga: "Ligatures", dlig: "Discretionary ligatures", calt: "Contextual alternates", salt: "Stylistic alternates",
  swsh: "Swashes", smcp: "Small caps", c2sc: "Caps to small caps", onum: "Oldstyle figures", lnum: "Lining figures",
  tnum: "Tabular figures", pnum: "Proportional figures", frac: "Fractions", zero: "Slashed zero", case: "Case-sensitive forms",
  ordn: "Ordinals", sups: "Superscript", subs: "Subscript", sinf: "Scientific inferiors", titl: "Titling", hist: "Historical",
  kern: "Kerning", cv01: "Character variant 1",
};
const TOGGLEABLE = /^(liga|dlig|calt|salt|swsh|smcp|c2sc|onum|lnum|tnum|pnum|frac|zero|case|ordn|sups|subs|sinf|titl|hist|kern|ss\d\d|cv\d\d)$/;
const SWATCHES = [
  { bg: "var(--card)", fg: "var(--ink)", name: "Paper" },
  { bg: "#17140f", fg: "#f4ede1", name: "Ink" },
  { bg: "#ff4a1c", fg: "#fff7ea", name: "Tomato" },
  { bg: "#2f5bff", fg: "#ffd34d", name: "Cobalt" },
  { bg: "#0f3d2e", fg: "#c9f27b", name: "Forest" },
  { bg: "#ffd6e7", fg: "#5b1037", name: "Bubblegum" },
];

// ------------------------------------------------------------------ state
const S = {
  lib: null, families: [], byKey: new Map(), collections: [],
  q: "", text: store.get("text", ""), size: store.get("size", 44), view: store.get("view", "grid"),
  sort: store.get("sort", "az"), cat: "all", vf: false, ital: false, script: "",
  picks: store.get("picks", []), seed: Math.random(),
  list: [], shown: 0, scope: null,
};

// ------------------------------------------------------------------ font loading
const faceLoads = new Map();
function loadFace(id) {
  if (!faceLoads.has(id)) {
    const ff = new FontFace(`tc-${id}`, `url(${U.font(id)})`);
    faceLoads.set(id, ff.load().then((f) => { document.fonts.add(f); return true; }).catch(() => false));
  }
  return faceLoads.get(id);
}
const ff = (id) => `'tc-${id}', var(--ui)`;
function applyFace(el, id) {
  return loadFace(id).then((ok) => {
    if (ok) el.style.fontFamily = ff(id); else el.title = "This font could not be previewed";
    el.classList.add("ready");
  });
}
const lazy = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { lazy.unobserve(e.target); applyFace(e.target, e.target.dataset.face); }
}, { rootMargin: "500px" });
function observeFaces(root) { $$("[data-face]:not(.ready)", root).forEach((el) => lazy.observe(el)); }

// ------------------------------------------------------------------ data
async function loadLibrary() {
  const lib = await api("/api/library");
  S.lib = lib;
  S.families = lib.families;
  S.collections = lib.collections;
  S.byKey = new Map(lib.families.map((f) => [f.key, f]));
  $("#upload-btn").hidden = lib.uploads === false;
  for (const f of S.families) {
    f._s = [f.name, f.designer, f.foundry, f.folder, f.category, CAT_LABEL[f.category], ...f.files, ...f.scripts,
      ...f.faces.map((x) => x.style), f.note, f.variable ? "variable" : "", f.mono ? "monospace" : ""].join(" ").toLowerCase();
  }
  S.picks = S.picks.filter((k) => S.byKey.has(k));
  renderTop();
  renderSide();
  renderTray();
}
const sampleFor = (f) => {
  if (S.text) return S.text;
  if (f.scripts.length && !f.scripts.includes("Latin")) {
    const s = f.scripts.find((x) => SCRIPT_SAMPLE[x]);
    if (s) return SCRIPT_SAMPLE[s];
  }
  return SAMPLES[f.category] || SAMPLES.other;
};
const wghtAxis = (f) => f.axes?.axes?.find((a) => a.tag === "wght");
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

// ------------------------------------------------------------------ top bar & side
function renderTop() {
  const st = S.lib.stats;
  $("#tagline").innerHTML = `<b>${st.families.toLocaleString()}</b> families · <b>${st.faces.toLocaleString()}</b> styles · ${fmtBytes(st.bytes)}`;
  shuffleWordmark(false);
  renderFooter();
}
function renderFooter() {
  const st = S.lib.stats;
  const scan = S.lib.scan;
  if (S.lib.version) $("#foot-version").textContent = `v${S.lib.version}`;
  $("#foot-stats").textContent = [
    plural(st.families, "family"), plural(st.faces, "style"), fmtBytes(st.bytes),
    scan.scanning ? `indexing ${scan.done}/${scan.total}` : scan.last ? `indexed ${timeAgo(scan.last)}` : "",
  ].filter(Boolean).join(" · ");
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) $$(".foot-keys kbd.mod").forEach((k) => { k.textContent = "⌘"; });
}
function shuffleWordmark(animate = true) {
  const wm = $("#wordmark");
  const pool = S.families.filter((f) => f.category !== "symbol" && f.scripts.includes("Latin"));
  wm.innerHTML = [...APP_NAME].map((ch) => `<span>${esc(ch)}</span>`).join("");
  if (!pool.length) return;
  $$("span", wm).forEach((sp, i) => {
    const f = pool[Math.floor(Math.random() * pool.length)];
    sp.title = f.name;
    loadFace(f.rep).then((ok) => { if (ok) sp.style.fontFamily = ff(f.rep); });
    if (animate) sp.style.animationDelay = `${i * 40}ms`;
  });
  if (animate) { wm.classList.remove("shuffle"); void wm.offsetWidth; wm.classList.add("shuffle"); }
}
// ------------------------------------------------------------------ themes
// c: [background, card, text, accent, blue, green, pink] for the picker previews.
const THEMES = [
  { id: "paper", name: "Paper", mode: "light", c: ["#f3eee4", "#fffbf3", "#17140f", "#ff4a1c", "#2f5bff", "#12a36b", "#f0458f"] },
  { id: "github-light", name: "GitHub Light", mode: "light", c: ["#f6f8fa", "#ffffff", "#1f2328", "#0969da", "#8250df", "#1a7f37", "#bf3989"] },
  { id: "solarized-light", name: "Solarized Light", mode: "light", c: ["#fdf6e3", "#fffbee", "#073642", "#cb4b16", "#268bd2", "#859900", "#d33682"] },
  { id: "catppuccin-latte", name: "Catppuccin Latte", mode: "light", c: ["#eff1f5", "#fbfbfd", "#4c4f69", "#8839ef", "#1e66f5", "#40a02b", "#ea76cb"] },
  { id: "gruvbox-light", name: "Gruvbox Light", mode: "light", c: ["#fbf1c7", "#fdf6d9", "#3c3836", "#af3a03", "#076678", "#79740e", "#8f3f71"] },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", mode: "light", c: ["#faf4ed", "#fffaf3", "#575279", "#a5566d", "#286983", "#56949f", "#907aa9"] },
  { id: "ink", name: "Ink", mode: "dark", c: ["#13110e", "#1d1a16", "#f4ede1", "#ff6a3d", "#6f8cff", "#3fd19a", "#ff6fae"] },
  { id: "dracula", name: "Dracula", mode: "dark", c: ["#21222c", "#282a36", "#f8f8f2", "#bd93f9", "#8be9fd", "#50fa7b", "#ff79c6"] },
  { id: "nord", name: "Nord", mode: "dark", c: ["#2e3440", "#353c4a", "#eceff4", "#88c0d0", "#81a1c1", "#a3be8c", "#b48ead"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", mode: "dark", c: ["#1e1e2e", "#24243a", "#cdd6f4", "#cba6f7", "#89b4fa", "#a6e3a1", "#f5c2e7"] },
  { id: "gruvbox-dark", name: "Gruvbox Dark", mode: "dark", c: ["#282828", "#2f2d2b", "#ebdbb2", "#fe8019", "#83a598", "#b8bb26", "#d3869b"] },
  { id: "tokyo-night", name: "Tokyo Night", mode: "dark", c: ["#1a1b26", "#1f2335", "#c0caf5", "#7aa2f7", "#bb9af7", "#9ece6a", "#f7768e"] },
];
const THEME_KEY = { mode: "tc.themeMode", light: "tc.themeLight", dark: "tc.themeDark" };
const rawGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? v.replace(/^"|"$/g, "") : d; } catch { return d; } };
const rawSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const sysDark = matchMedia("(prefers-color-scheme: dark)");
const themeById = (id) => THEMES.find((t) => t.id === id);
function themePrefs() {
  const legacy = rawGet("tc.theme", null);            // before 0.2: "light" | "dark"
  if (legacy && !rawGet(THEME_KEY.mode, null)) {
    rawSet(THEME_KEY.mode, legacy === "dark" ? "dark" : "light");
    try { localStorage.removeItem("tc.theme"); } catch { /* */ }
  }
  const light = themeById(rawGet(THEME_KEY.light, "paper"));
  const dark = themeById(rawGet(THEME_KEY.dark, "ink"));
  return {
    mode: rawGet(THEME_KEY.mode, "auto"),
    light: light && light.mode === "light" ? light.id : "paper",
    dark: dark && dark.mode === "dark" ? dark.id : "ink",
  };
}
function applyTheme() {
  const p = themePrefs();
  const dark = p.mode === "dark" || (p.mode === "auto" && sysDark.matches);
  const t = themeById(dark ? p.dark : p.light);
  const de = document.documentElement;
  de.dataset.theme = t.id;
  de.dataset.mode = t.mode;
  const btn = $("#theme-btn");
  btn.innerHTML = ICON.palette;
  btn.title = `Theme: ${t.name}${p.mode === "auto" ? " (matching system)" : ""}`;
  $$(".theme-picker").forEach((el) => { el.outerHTML = themePickerHTML(); });
}
function pickTheme(id) {
  const t = themeById(id);
  if (!t) return;
  rawSet(t.mode === "dark" ? THEME_KEY.dark : THEME_KEY.light, t.id);
  if (themePrefs().mode !== "auto") rawSet(THEME_KEY.mode, t.mode);
  else if ((t.mode === "dark") !== sysDark.matches) toast(`${t.name} will be used when your system is in ${t.mode} mode`);
  applyTheme();
}
function setThemeAuto(on) {
  rawSet(THEME_KEY.mode, on ? "auto" : document.documentElement.dataset.mode);
  applyTheme();
}
function toggleDark() {
  rawSet(THEME_KEY.mode, document.documentElement.dataset.mode === "dark" ? "light" : "dark");
  applyTheme();
  toast(`${themeById(document.documentElement.dataset.theme).name} theme`);
}
sysDark.addEventListener("change", () => { if (themePrefs().mode === "auto") applyTheme(); });
function themePickerHTML() {
  const p = themePrefs();
  const cur = document.documentElement.dataset.theme;
  const card = (t) => {
    const preferred = p.mode === "auto" && (p.light === t.id || p.dark === t.id);
    return `<button type="button" class="theme-card ${cur === t.id ? "on" : ""} ${preferred ? "pref" : ""}" data-theme-pick="${t.id}"
      aria-pressed="${cur === t.id}" style="--tp:${t.c[0]};--tc:${t.c[1]};--ti:${t.c[2]};--ta:${t.c[3]}">
      <span class="tp-prev"><span class="tp-win"><b>Aa</b><i></i><i class="short"></i><em></em></span>
        <span class="tp-dots">${t.c.slice(3).map((c) => `<i style="background:${c}"></i>`).join("")}</span></span>
      <span class="tp-name">${esc(t.name)}${preferred && cur !== t.id ? `<small>${t.mode}</small>` : ""}</span></button>`;
  };
  return `<div class="theme-picker">
    <label class="tp-auto"><input type="checkbox" data-theme-auto ${p.mode === "auto" ? "checked" : ""}>
      <span><b>Match system</b><small>${p.mode === "auto"
        ? `${esc(themeById(p.light).name)} when your system is light, ${esc(themeById(p.dark).name)} when it's dark`
        : "Switch between your light and dark theme with your OS"}</small></span></label>
    <h5>Light</h5><div class="tp-grid">${THEMES.filter((t) => t.mode === "light").map(card).join("")}</div>
    <h5>Dark</h5><div class="tp-grid">${THEMES.filter((t) => t.mode === "dark").map(card).join("")}</div>
  </div>`;
}
function openThemePanel() {
  closeMenu();
  const panel = $("#theme-panel");
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.innerHTML = `<div class="tp-head"><b>Theme</b><a href="#/settings" data-close-theme>All settings →</a></div>${themePickerHTML()}`;
  panel.hidden = false;
  const r = $("#theme-btn").getBoundingClientRect();
  panel.style.top = `${r.bottom + 8}px`;
  panel.style.right = `${Math.max(8, innerWidth - r.right)}px`;
}
document.addEventListener("click", (e) => {
  const pick = e.target.closest("[data-theme-pick]");
  if (pick) { pickTheme(pick.dataset.themePick); return; }
  const panel = $("#theme-panel");
  if (!panel.hidden && (e.target.closest("[data-close-theme]") || (!e.target.closest("#theme-panel") && !e.target.closest("#theme-btn")))) panel.hidden = true;
});
document.addEventListener("change", (e) => { if (e.target.matches("[data-theme-auto]")) setThemeAuto(e.target.checked); });

function renderSide() {
  const r = route();
  const st = S.lib.stats;
  const nfav = S.families.filter((f) => f.favorite).length;
  const scan = S.lib.scan;
  const navA = (href, icon, label, count, active) =>
    `<a class="nav ${active ? "active" : ""}" href="${href}">${icon}<span>${label}</span>${count !== undefined ? `<span class="count">${count}</span>` : ""}</a>`;
  $("#side").innerHTML = `
    <h4>Library</h4>
    ${navA("#/", ICON.all, "All fonts", st.families, r.name === "all")}
    ${navA("#/fav", ICON.heart, "Favourites", nfav, r.name === "fav")}
    ${navA("#/recent", ICON.clock, "Recently added", undefined, r.name === "recent")}
    <button class="nav" data-act="surprise">${ICON.dice}<span>Surprise me</span></button>
    <h4>Collections <button class="icon-btn" data-act="newcoll" title="New collection" style="width:24px;height:24px">${ICON.plus}</button></h4>
    ${S.collections.length ? S.collections.map((c) => navA(`#/c/${c.id}`, ICON.folder, esc(c.name), c.count, r.name === "coll" && r.id === c.id)).join("")
      : `<div style="padding:4px 10px;font-size:12.5px;color:var(--muted)">Group fonts for a project: use <b>⋯</b> on any card.</div>`}
    <h4>Tools</h4>
    ${navA("#/compare", ICON.compare, "Compare", S.picks.length || undefined, r.name === "compare")}
    ${navA("#/health", ICON.alert, "Duplicates & issues", (st.duplicates + st.broken) || undefined, r.name === "health")}
    ${navA("#/settings", ICON.gear, "Settings", undefined, r.name === "settings")}
    <div class="side-foot">
      <div>${plural(st.files, "file")} · ${fmtBytes(st.bytes)}</div>
      ${scan.scanning ? `<div>Indexing ${scan.done} / ${scan.total}…</div><div class="bar"><i style="width:${scan.total ? (100 * scan.done / scan.total) : 0}%"></i></div>`
        : `<div>Indexed ${scan.last ? timeAgo(scan.last) : "—"}</div>`}
      <button class="btn small ghost" data-act="rescan" style="align-self:flex-start">${ICON.refresh} Rescan folder</button>
    </div>`;  renderFooter();
}
function timeAgo(t) {
  const s = Date.now() / 1000 - t;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ------------------------------------------------------------------ router
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/").map(decodeURIComponent);
  if (!a) return { name: "all" };
  if (a === "fav") return { name: "fav" };
  if (a === "recent") return { name: "recent" };
  if (a === "c") return { name: "coll", id: Number(b) };
  if (a === "f") return { name: "family", key: b };
  if (a === "compare") return { name: "compare" };
  if (a === "health") return { name: "health" };
  if (a === "settings") return { name: "settings" };
  return { name: "all" };
}
let lastGalleryScroll = 0;
let lastRouteName = "";
function render() {
  closeMenu();
  const r = route();
  if (lastRouteName && ["all", "fav", "recent", "coll"].includes(lastRouteName) && r.name === "family") lastGalleryScroll = scrollY;
  renderSide();
  if (r.name === "family") familyPage(r.key);
  else if (r.name === "compare") comparePage();
  else if (r.name === "health") healthPage();
  else if (r.name === "settings") settingsPage();
  else {
    const back = r.name === "all" && lastRouteName === "family";
    gallery(r);
    if (back) requestAnimationFrame(() => scrollTo(0, lastGalleryScroll)); else scrollTo(0, 0);
  }
  lastRouteName = r.name;
}

// ------------------------------------------------------------------ gallery
function scoped(r) {
  let f = S.families;
  if (r.name === "fav") f = f.filter((x) => x.favorite);
  if (r.name === "coll") f = f.filter((x) => x.collections.includes(r.id));
  return f;
}
function applyFilters(fams, { skipCat = false } = {}) {
  const toks = S.q.toLowerCase().split(/\s+/).filter(Boolean);
  return fams.filter((f) =>
    (skipCat || S.cat === "all" || f.category === S.cat) &&
    (!S.vf || f.variable) && (!S.ital || f.italic) &&
    (!S.script || f.scripts.includes(S.script)) &&
    toks.every((t) => f._s.includes(t)));
}
function sorted(fams, r) {
  const a = [...fams];
  const sort = r.name === "recent" ? "new" : S.sort;
  if (sort === "az") a.sort((x, y) => x.name.localeCompare(y.name));
  if (sort === "new") a.sort((x, y) => y.added - x.added || x.name.localeCompare(y.name));
  if (sort === "styles") a.sort((x, y) => y.styles - x.styles || (y.variable - x.variable) || x.name.localeCompare(y.name));
  if (sort === "shuffle") a.sort((x, y) => hash(x.key + S.seed) - hash(y.key + S.seed));
  return r.name === "recent" ? a.slice(0, 120) : a;
}
function gallery(r) {
  S.scope = r;
  const coll = r.name === "coll" ? S.collections.find((c) => c.id === r.id) : null;
  const title = { all: "", fav: "Favourites", recent: "Recently added", coll: coll ? coll.name : "Collection" }[r.name];
  const scripts = [...new Set(S.families.flatMap((f) => f.scripts))].sort();
  $("#view").innerHTML = `
    <div class="toolbar">
      ${title ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <h1 style="margin:0;font-size:26px;letter-spacing:-.02em">${esc(title)}</h1>
        ${coll ? `${U.collection(coll.id) ? `<a class="btn small" href="${U.collection(coll.id)}">${ICON.download} Download all</a>` : ""}
          <button class="btn small ghost" data-act="renamecoll">${ICON.pen} Rename</button>
          <button class="btn small ghost" data-act="delcoll">${ICON.trash} Delete</button>` : ""}
      </div>` : ""}
      <div class="tool-row">
        <label class="field search">${ICON.search}<input id="q" placeholder="Search name, designer, folder…" value="${esc(S.q)}" autocomplete="off"><kbd>/</kbd></label>
        <label class="field sample"><input id="sample" placeholder="Type your own preview text…" value="${esc(S.text)}" autocomplete="off">
          <span class="presets">${PRESETS.map(([l, t], i) => `<button type="button" data-preset="${i}" title="${esc(t || "Category pangrams")}">${esc(l)}</button>`).join("")}</span></label>
        <label class="size-ctl"><span>Aa</span><input type="range" id="size" min="14" max="140" value="${S.size}"><span id="size-v">${S.size}px</span></label>
      </div>
      <div class="chips-row">
        <div class="chips" id="chips"></div>
        <div class="viewctl">
          <select class="sel" id="sort" title="Sort" ${r.name === "recent" ? "disabled" : ""}>
            ${[["az", "A → Z"], ["new", "Newest"], ["styles", "Most styles"], ["shuffle", "Shuffle"]].map(([v, l]) => `<option value="${v}" ${S.sort === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          <div class="seg" role="group" aria-label="View">
            <button data-view="grid" class="${S.view === "grid" ? "on" : ""}" title="Grid">${ICON.grid}</button>
            <button data-view="list" class="${S.view === "list" ? "on" : ""}" title="List">${ICON.list}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="result-line" id="result-line"></div>
    <div class="grid ${S.view === "list" ? "list" : ""}" id="grid" style="--sz:${S.size}px"></div>
    <div class="sentinel" id="sentinel"></div>`;
  const opts = $("#chips");
  opts.dataset.scripts = scripts.join(",");
  refreshGallery();
}
function renderChips() {
  const base = applyFilters(scoped(S.scope), { skipCat: true });
  const counts = {};
  base.forEach((f) => { counts[f.category] = (counts[f.category] || 0) + 1; });
  const scripts = ($("#chips").dataset.scripts || "").split(",").filter(Boolean);
  $("#chips").innerHTML = `
    <button class="chip-btn ${S.cat === "all" ? "on" : ""}" data-cat="all">All <span class="n">${base.length}</span></button>
    ${CATS.filter(([c]) => counts[c] || S.cat === c).map(([c, l]) =>
      `<button class="chip-btn c-${c} ${S.cat === c ? "on" : ""}" data-cat="${c}"><span class="sw" style="background:var(--c)"></span>${l} <span class="n">${counts[c] || 0}</span></button>`).join("")}
    <span class="sep"></span>
    <button class="chip-btn ${S.vf ? "on" : ""}" data-flag="vf">Variable</button>
    <button class="chip-btn ${S.ital ? "on" : ""}" data-flag="ital">Has italics</button>
    ${scripts.length > 1 ? `<select class="sel" id="script" title="Language support">
      <option value="">Any script</option>${scripts.map((s) => `<option ${S.script === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>` : ""}`;
}
function refreshGallery() {
  renderChips();
  S.list = sorted(applyFilters(scoped(S.scope)), S.scope);
  S.shown = 0;
  const grid = $("#grid");
  grid.innerHTML = "";
  const total = scoped(S.scope).length;
  $("#result-line").innerHTML = S.list.length === total
    ? `<span><b>${plural(S.list.length, "family")}</b>${S.scope.name === "all" ? " in your case" : ""}</span>`
    : `<span><b>${S.list.length.toLocaleString()}</b> of ${plural(total, "family")}</span> <button class="btn small ghost" data-act="clear">Clear filters</button>`;
  if (!S.families.length) {
    grid.outerHTML = `<div class="empty" id="grid"><div class="big">Aa</div><h2>Your type case is empty</h2>
      <p>Drop font files or .zip archives anywhere on this page, or put them in the fonts folder and hit <b>Rescan</b>.</p>
      <button class="btn accent" data-act="upload">${ICON.plus} Add fonts</button></div>`;
    return;
  }
  if (!S.list.length) {
    grid.insertAdjacentHTML("beforeend", `<div class="empty" style="grid-column:1/-1"><div class="big">?</div><h2>Nothing matches</h2>
      <p>${S.scope.name === "coll" ? "This collection is empty. Add fonts with <b>⋯ → Add to collection</b>." : S.scope.name === "fav" ? "Tap the ♥ on fonts you love and they'll live here." : "Try a different search or clear the filters."}</p></div>`);
    return;
  }
  moreCards();
}
function weightBars(f) {
  const ax = wghtAxis(f);
  return [100, 200, 300, 400, 500, 600, 700, 800, 900].map((w, i) => {
    const has = ax ? w >= ax.min && w <= ax.max : f.weights.some((x) => Math.abs(x - w) < 50);
    return `<i class="${has ? "has" : ""}" style="height:${5 + i}px"></i>`;
  }).join("");
}
function cardHTML(f, i) {
  const picked = S.picks.includes(f.key);
  const ax = wghtAxis(f);
  const meta = f.variable ? (ax ? `${Math.round(ax.min)}–${Math.round(ax.max)}` : "variable") : plural(f.styles, "style");
  return `<article class="card c-${f.category} ${picked ? "picked" : ""}" data-key="${esc(f.key)}" style="animation-delay:${(i % 30) * 16}ms">
    <div class="card-top"><span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span class="fmeta">${esc(meta)}</span>
      <span class="acts ${f.favorite ? "has-on" : ""}">
        <button class="icon-btn ${f.favorite ? "on" : ""}" data-act="fav" title="Favourite">${ICON.heart}</button>
        <button class="icon-btn" data-act="more" title="More">${ICON.more}</button></span></div>
    <div class="specimen" data-face="${esc(f.rep)}">${esc(sampleFor(f))}</div>
    <div class="card-foot">
      <span class="tag">${CAT_LABEL[f.category]}</span>${f.variable ? '<span class="tag plain" title="Variable font">VF</span>' : ""}
      <span class="who" title="${esc(f.designer || f.foundry)}">${esc(f.designer || f.foundry || f.folder)}</span>
      <span class="weights" title="Weights">${weightBars(f)}</span>
      <button class="icon-btn ${picked ? "on" : ""}" data-act="pick" title="${picked ? "Remove from compare" : "Add to compare"}">${ICON.compare}</button>
      <a class="icon-btn" href="${U.family(f.key)}" download="${esc(f.name)}.zip" title="Download ${f.styles > 1 ? "family (.zip)" : "font (.zip)"}" data-act="dl">${ICON.download}</a>
    </div></article>`;
}
const BATCH = 48;
function moreCards() {
  const grid = $("#grid");
  if (!grid || S.shown >= S.list.length) return;
  const slice = S.list.slice(S.shown, S.shown + BATCH);
  grid.insertAdjacentHTML("beforeend", slice.map((f, i) => cardHTML(f, i)).join(""));
  S.shown += slice.length;
  observeFaces(grid);
}
const sentinelObs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) moreCards(); }, { rootMargin: "1200px" });
new MutationObserver(() => { const s = $("#sentinel"); if (s && !s._obs) { s._obs = true; sentinelObs.observe(s); } }).observe(document.body, { childList: true, subtree: true });

function updateSpecimens() {
  $$("#grid .card").forEach((c) => {
    const f = S.byKey.get(c.dataset.key);
    if (f) $(".specimen", c).textContent = sampleFor(f);
  });
}

// hover: sweep the weight axis (variable) or flip through the styles (static)
let hoverTimer = null;
let hoverCard = null;
function hoverStart(card) {
  if (hoverCard === card) return;
  hoverStop();
  hoverCard = card;
  const f = S.byKey.get(card.dataset.key);
  const sp = $(".specimen", card);
  if (!f || !sp) return;
  const ax = wghtAxis(f);
  if (ax) {
    sp.style.fontVariationSettings = `'wght' ${ax.max}`;
    hoverTimer = setTimeout(() => { sp.style.fontVariationSettings = `'wght' ${ax.min}`; }, 1250);
    return;
  }
  const faces = f.faces.filter((x) => !x.italic).length > 1 ? f.faces.filter((x) => !x.italic) : f.faces;
  if (faces.length < 2) return;
  let i = 0;
  faces.forEach((x) => loadFace(x.id));
  hoverTimer = setInterval(() => {
    i = (i + 1) % faces.length;
    loadFace(faces[i].id).then((ok) => { if (ok && hoverCard === card) sp.style.fontFamily = ff(faces[i].id); });
  }, 520);
}
function hoverStop() {
  if (!hoverCard) return;
  clearInterval(hoverTimer); clearTimeout(hoverTimer);
  const f = S.byKey.get(hoverCard.dataset.key);
  const sp = $(".specimen", hoverCard);
  if (sp && f) { sp.style.fontVariationSettings = ""; if (sp.classList.contains("ready")) sp.style.fontFamily = ff(f.rep); }
  hoverCard = null;
}

// ------------------------------------------------------------------ family actions
async function toggleFav(key) {
  const f = S.byKey.get(key);
  const { favorite } = await api(`/api/favorite/${enc(key)}`, { method: "POST" });
  if (f) f.favorite = favorite;
  $$(`.card[data-key="${CSS.escape(key)}"] [data-act=fav]`).forEach((b) => { b.classList.toggle("on", favorite); b.parentElement.classList.toggle("has-on", favorite); });
  $$(`[data-famfav="${CSS.escape(key)}"]`).forEach((b) => { b.classList.toggle("on", favorite); b.innerHTML = `${ICON.heart} ${favorite ? "Favourited" : "Favourite"}`; });
  renderSide();
  toast(favorite ? `♥ ${f ? f.name : "Font"} added to favourites` : "Removed from favourites");
}
function togglePick(key) {
  const i = S.picks.indexOf(key);
  if (i >= 0) S.picks.splice(i, 1);
  else {
    if (S.picks.length >= 8) { toast("Compare holds up to 8 fonts. Remove one first."); return; }
    S.picks.push(key);
  }
  store.set("picks", S.picks);
  $$(`.card[data-key="${CSS.escape(key)}"]`).forEach((c) => {
    const on = S.picks.includes(key);
    c.classList.toggle("picked", on);
    const b = $("[data-act=pick]", c);
    b.classList.toggle("on", on);
    b.title = on ? "Remove from compare" : "Add to compare";
  });
  renderTray();
  renderSide();
  if (route().name === "compare") comparePage();
}
function renderTray() {
  const tray = $("#tray");
  if (!S.picks.length || route().name === "compare") { tray.hidden = true; return; }
  tray.hidden = false;
  tray.innerHTML = `<span style="font-size:13px;opacity:.75">Compare</span><div class="picks">${S.picks.map((k) => {
    const f = S.byKey.get(k);
    return `<span class="pk">${esc(f ? f.name : k)}<button data-unpick="${esc(k)}" title="Remove">✕</button></span>`;
  }).join("")}</div>
    <a class="btn accent small" href="#/compare">${ICON.compare} Compare ${S.picks.length}</a>
    <button class="btn ghost small" data-act="clearpicks">Clear</button>`;
}
async function setCategory(key, cat) {
  await api(`/api/category/${enc(key)}`, { json: { category: cat } });
  await loadLibrary();
  render();
  toast(cat ? `Filed under ${CAT_LABEL[cat]}` : "Back to automatic category");
}
async function toggleCollection(cid, key) {
  const { member } = await api(`/api/collections/${cid}/toggle/${enc(key)}`, { method: "POST" });
  const c = S.collections.find((x) => x.id === cid);
  await loadLibrary();
  if (route().name === "coll") render();
  toast(member ? `Added to ${c ? c.name : "collection"}` : `Removed from ${c ? c.name : "collection"}`);
}
async function newCollection(withKey) {
  const name = await askText("New collection", "e.g. Wedding invite, Blog redesign");
  if (!name) return;
  const res = await api("/api/collections", { json: { name, fonts: withKey ? [withKey] : [] } });
  await loadLibrary();
  toast(`Collection “${res.name}” created`);
  if (!withKey) location.hash = `#/c/${res.id}`;
  else if (route().name !== "family") render();
}
function familyMenu(key, anchor) {
  const f = S.byKey.get(key);
  if (!f) return;
  const items = [
    { icon: ICON.open, label: "Open", run: () => { location.hash = `#/f/${enc(key)}`; } },
    { icon: ICON.compare, label: S.picks.includes(key) ? "Remove from compare" : "Add to compare", run: () => togglePick(key) },
    { icon: ICON.download, label: "Download family (.zip)", href: U.family(key), download: `${f.name}.zip` },
    { icon: ICON.copy, label: "Copy name", run: () => copy(f.name, "Name copied") },
    "hr", { lbl: "Collections" },
    ...S.collections.map((c) => ({ check: f.collections.includes(c.id), label: c.name, run: () => toggleCollection(c.id, key) })),
    { icon: ICON.plus, label: "New collection…", run: () => newCollection(key) },
    "hr", { lbl: "Category" },
    ...CATS.map(([c, l]) => ({ check: f.category === c, label: l + (f.category_auto === c ? " (auto)" : ""), run: () => setCategory(key, c === f.category_auto ? "" : c) })),
  ];
  showMenu(anchor, items);
}

// ------------------------------------------------------------------ menu / toast / ask / copy
function showMenu(anchor, items) {
  const m = $("#menu");
  m.innerHTML = items.map((it, i) => {
    if (it === "hr") return "<hr>";
    if (it.lbl) return `<div class="lbl">${esc(it.lbl)}</div>`;
    const inner = `${it.check !== undefined ? `<span class="chk">${it.check ? "✓" : ""}</span>` : it.icon || ""}<span>${esc(it.label)}</span>`;
    return it.href ? `<a href="${it.href}" ${it.download ? `download="${esc(it.download)}"` : ""} data-i="${i}">${inner}</a>` : `<button data-i="${i}">${inner}</button>`;
  }).join("");
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = `${Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw))}px`;
  m.style.top = `${r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  m.onclick = (e) => {
    const el = e.target.closest("[data-i]");
    if (!el) return;
    const it = items[Number(el.dataset.i)];
    closeMenu();
    if (it.run) { e.preventDefault(); it.run(); }
  };
}
function closeMenu() { $("#menu").hidden = true; }
function toast(html, { sticky = false, raw = false } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = raw ? html : esc(html);
  $("#toasts").appendChild(el);
  const kill = () => { el.style.transition = "opacity .3s"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); };
  if (!sticky) setTimeout(kill, 3200);
  return { el, kill, set(h) { el.innerHTML = h; } };
}
function copy(text, msg) {
  navigator.clipboard?.writeText(text).then(() => toast(msg || "Copied"), () => toast("Couldn't copy"));
}
function askText(title, placeholder, value = "") {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "palette";
    wrap.innerHTML = `<div class="palette-box"><div style="padding:16px 20px 0;font-weight:650">${esc(title)}</div>
      <input placeholder="${esc(placeholder)}" value="${esc(value)}" maxlength="80">
      <div class="palette-foot"><span>↵ save</span><span>esc cancel</span></div></div>`;
    document.body.appendChild(wrap);
    const input = $("input", wrap);
    input.focus(); input.select();
    const done = (v) => { wrap.remove(); resolve(v); };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim());
      if (e.key === "Escape") done("");
    });
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(""); });
  });
}

// ------------------------------------------------------------------ family page
async function familyPage(key) {
  const view = $("#view");
  view.innerHTML = `<div class="fam"><div class="crumbs"><a href="#/">${ICON.back} All fonts</a></div><div class="hero"><h1 style="opacity:.2">Loading…</h1></div></div>`;
  let f;
  try { f = await api(`/api/family/${enc(key)}`); } catch {
    view.innerHTML = `<div class="empty"><div class="big">?</div><h2>Font not found</h2><p>It may have been moved or removed.</p><a class="btn" href="#/">Back to the library</a></div>`;
    return;
  }
  if (route().key !== key) return;
  const rep = f.faces.find((x) => x.id === f.rep) || f.faces[0];
  const T = { face: rep.id, size: 64, lh: 1.15, ls: 0, align: "left", sw: 0, axes: {}, feats: new Set() };
  const axesOf = (face) => face.axes?.axes || [];
  const ax = wghtAxis(f);
  const styleLabel = f.variable && ax ? `Variable · weight ${Math.round(ax.min)}–${Math.round(ax.max)}` : plural(f.styles, "style");
  const feats = [...new Set(f.faces.flatMap((x) => x.features))].filter((t) => TOGGLEABLE.test(t)).sort();
  const others = S.families.filter((x) => x.key !== f.key && x.category !== "symbol");
  const sample = sampleFor(f);

  view.innerHTML = `<div class="fam c-${f.category}">
    <div class="crumbs"><a href="#/">${ICON.back} All fonts</a><span>/</span><span>${esc(CAT_LABEL[f.category])}</span></div>
    <div class="hero">
      <h1 data-face="${esc(rep.id)}">${esc(f.name)}</h1>
      <div class="sub">
        <button class="tag" data-act="catmenu" title="Change category">${esc(CAT_LABEL[f.category])} ▾</button>
        <span><b>${esc(styleLabel)}</b></span>
        ${f.designer ? `<span>by <b>${esc(f.designer)}</b></span>` : ""}
        ${f.foundry && f.foundry !== f.designer ? `<span>${esc(f.foundry)}</span>` : ""}
        ${f.scripts.length ? `<span>${esc(f.scripts.join(" · "))}</span>` : ""}
      </div>
      <div class="actions">
        <a class="btn primary" href="${U.family(f.key)}" download="${esc(f.name)}.zip">${ICON.download} Download ${f.styles > 1 ? "family" : "font"} (.zip)</a>
        <button class="btn ${f.favorite ? "on" : ""}" data-famfav="${esc(f.key)}" data-act="famfav">${ICON.heart} ${f.favorite ? "Favourited" : "Favourite"}</button>
        <button class="btn" data-act="fammore">${ICON.folder} Collections</button>
        <button class="btn" data-act="pickfam">${ICON.compare} ${S.picks.includes(f.key) ? "In compare" : "Compare"}</button>
        <button class="btn" data-act="specimen">${ICON.image} Specimen PNG</button>
      </div>
    </div>
    <nav class="secnav"><a href="#tester" data-jump>Type tester</a><a href="#styles" data-jump>Styles</a><a href="#waterfall" data-jump>Waterfall</a><a href="#glyphs" data-jump>Glyphs</a><a href="#pairing" data-jump>Pairing</a><a href="#about" data-jump>About & files</a></nav>

    <section class="sec" id="tester"><h2>Type tester</h2>
      <div class="tester">
        <div class="tester-ctl">
          ${f.faces.length > 1 ? `<label>Style <select class="sel" id="t-face">${f.faces.map((x) => `<option value="${esc(x.id)}" ${x.id === rep.id ? "selected" : ""}>${esc(x.style)}${x.variable ? "" : ` · ${x.weight}`}</option>`).join("")}</select></label>` : ""}
          <label>Size <input type="range" id="t-size" min="12" max="200" value="${T.size}"><span class="val" id="t-size-v">${T.size}</span></label>
          <label>Leading <input type="range" id="t-lh" min="0.8" max="2.2" step="0.05" value="${T.lh}"><span class="val" id="t-lh-v">${T.lh}</span></label>
          <label>Tracking <input type="range" id="t-ls" min="-0.1" max="0.4" step="0.005" value="0"><span class="val" id="t-ls-v">0</span></label>
          <div class="seg" style="height:32px">${["left", "center", "right"].map((a) => `<button data-align="${a}" class="${a === "left" ? "on" : ""}" style="font-size:12px">${a[0].toUpperCase() + a.slice(1)}</button>`).join("")}</div>
          <div class="swatches">${SWATCHES.map((s, i) => `<button data-sw="${i}" title="${s.name}" class="${i === 0 ? "on" : ""}" style="background:${s.bg};--fg:${s.fg}"></button>`).join("")}</div>
        </div>
        <div class="axes" id="t-axes" hidden></div>
        ${feats.length ? `<div class="feats" id="t-feats"><span class="lbl">OpenType features</span>${feats.map((t) => `<button data-feat="${t}" title="${esc(FEATURE_NAMES[t] || (t.startsWith("ss") ? `Stylistic set ${Number(t.slice(2))}` : t.startsWith("cv") ? `Character variant ${Number(t.slice(2))}` : t))}">${t}</button>`).join("")}</div>` : ""}
        <div class="tester-area" id="t-area" contenteditable="true" spellcheck="false" data-face="${esc(rep.id)}">${esc(S.text || sample)}</div>
      </div>
    </section>

    <section class="sec" id="styles"><h2>${plural(f.faces.length, "style")}</h2>
      <div class="styles-list">${f.faces.map((x) => `<div class="style-row">
        <div class="nm">${esc(x.style)}<small>${x.variable ? "variable" : x.weight}${x.italic ? " · italic" : ""} · ${esc(x.fmt.toUpperCase())}</small></div>
        <div class="sp" data-face="${esc(x.id)}">${esc(S.text || sample)}</div>
        <a class="icon-btn" href="${U.face(x.id)}" download="${esc(fileName(x.path))}" title="Download ${esc(fileName(x.path))}">${ICON.download}</a></div>`).join("")}</div>
    </section>

    <section class="sec" id="waterfall"><h2>Waterfall</h2>
      <div class="waterfall" id="wf">${[12, 14, 16, 20, 24, 32, 40, 48, 64, 80, 96].map((s) => `<div class="wl"><span>${s}</span><span style="font-size:${s}px" data-face="${esc(rep.id)}">${esc(S.text || sample)}</span></div>`).join("")}</div>
    </section>

    <section class="sec" id="glyphs"><h2>Glyphs</h2>
      <div class="glyph-tools"><label class="field" style="height:34px;max-width:260px">${ICON.search}<input id="g-q" placeholder="Find a character or U+ code"></label>
        ${f.faces.length > 1 ? `<select class="sel" id="g-face" style="height:34px">${f.faces.map((x) => `<option value="${esc(x.id)}" ${x.id === rep.id ? "selected" : ""}>${esc(x.style)}</option>`).join("")}</select>` : ""}
        <span id="g-count" style="font-size:13px;color:var(--muted)"></span></div>
      <div class="glyph-wrap"><div><div class="glyphs" id="g-grid"></div><div id="g-more" style="margin-top:12px"></div></div>
        <aside class="inspector" id="g-insp"><div class="g" id="g-big" data-face="${esc(rep.id)}">${esc(sample[0] || "A")}</div>
          <div class="code" id="g-code">Pick a glyph</div>
          <button class="btn small" id="g-copy">${ICON.copy} Copy character</button></aside></div>
    </section>

    <section class="sec" id="pairing"><h2>Pairing</h2>
      <div class="pair">
        <div class="pair-ctl"><span id="p-role">${esc(f.name)} as <b>heading</b>, with</span>
          <select class="sel" id="p-with" style="height:34px;max-width:260px">${others.map((x) => `<option value="${esc(x.key)}">${esc(x.name)}</option>`).join("")}</select>
          <button class="btn small" data-act="pairshuffle">${ICON.dice} Suggest</button>
          <button class="btn small ghost" data-act="pairswap">Swap roles</button></div>
        <div class="pair-body" id="p-body"></div>
      </div>
    </section>

    <section class="sec" id="about"><h2>About & files</h2>
      <div class="about">
        <div class="box"><h3>Details</h3><dl class="kv">
          <dt>Family</dt><dd>${esc(f.name)}</dd>
          ${f.designer ? `<dt>Designer</dt><dd>${f.designer_url ? `<a href="${esc(safeUrl(f.designer_url))}" target="_blank" rel="noopener noreferrer">${esc(f.designer)}</a>` : esc(f.designer)}</dd>` : ""}
          ${f.foundry ? `<dt>Foundry</dt><dd>${esc(f.foundry)}</dd>` : ""}
          ${f.version ? `<dt>Version</dt><dd>${esc(f.version)}</dd>` : ""}
          <dt>Category</dt><dd>${esc(CAT_LABEL[f.category])}${f.category !== f.category_auto ? " (set by you)" : ""}</dd>
          <dt>Glyphs</dt><dd>${f.faces.map((x) => x.glyphs).reduce((a, b) => Math.max(a, b), 0).toLocaleString()}</dd>
          <dt>Scripts</dt><dd>${esc(f.scripts.join(", ") || "—")}</dd>
          <dt>Added</dt><dd>${new Date(f.added * 1000).toLocaleDateString()}</dd>
        </dl></div>
        <div class="box"><h3>License</h3><div class="license">${esc(f.license_full || "No license text in the font.")}</div>
          ${f.license_url ? `<p style="margin:10px 0 0;font-size:13px"><a href="${esc(safeUrl(f.license_url))}" target="_blank" rel="noopener noreferrer">${esc(f.license_url)}</a></p>` : ""}</div>
        <div class="box"><h3>Files</h3><div class="files">${f.faces.map((x) => `<a href="${U.face(x.id)}" download="${esc(fileName(x.path))}" title="Download">${ICON.download}<span>${esc(x.path)}${f.faces.filter((y) => y.path === x.path).length > 1 ? ` #${x.idx}` : ""}</span><span class="sz">${fmtBytes(x.size)}</span></a>`).join("")}</div>
          ${f.paths.length > new Set(f.faces.map((x) => x.path)).size ? `<p style="font-size:12px;color:var(--muted);margin:10px 0 0">Also stored at: ${f.paths.filter((p) => !f.faces.some((x) => x.path === p.path)).map((p) => esc(p.path)).join(", ")}</p>` : ""}
          ${f.features.length ? `<h3 style="margin-top:16px">OpenType features</h3><div class="pills">${f.features.map((t) => `<span class="tag plain" title="${esc(FEATURE_NAMES[t] || "")}">${esc(t)}</span>`).join("")}</div>` : ""}</div>
        <div class="box"><h3>Notes</h3><textarea class="note" id="note" placeholder="Where it's from, what it's for, who paid for it…">${esc(f.note)}</textarea>
          <div style="font-size:12px;color:var(--muted);margin-top:6px" id="note-state">Saved automatically. Notes are searchable.</div></div>
      </div>
    </section>
  </div>`;
  observeFaces(view);
  f.faces.forEach((x) => loadFace(x.id));

  // ---- tester
  const area = $("#t-area");
  const faceById = (id) => f.faces.find((x) => x.id === id);
  const applyTester = () => {
    const face = faceById(T.face);
    loadFace(T.face).then(() => { area.style.fontFamily = ff(T.face); area.classList.add("ready"); });
    area.style.fontSize = `${T.size}px`;
    area.style.lineHeight = T.lh;
    area.style.letterSpacing = `${T.ls}em`;
    area.style.textAlign = T.align;
    const sw = SWATCHES[T.sw];
    area.style.background = sw.bg;
    area.style.color = sw.fg;
    const axs = axesOf(face);
    area.style.fontVariationSettings = axs.length ? axs.map((a) => `'${a.tag}' ${T.axes[a.tag] ?? a.default}`).join(", ") : "";
    area.style.fontFeatureSettings = [...T.feats].map((t) => `'${t}' 1`).join(", ");
  };
  const renderAxes = () => {
    const face = faceById(T.face);
    const axs = axesOf(face);
    const box = $("#t-axes");
    box.hidden = !axs.length;
    if (!axs.length) return;
    const inst = face.axes.instances || [];
    box.innerHTML = axs.map((a) => `<label><span class="tagname">${esc(a.tag)}</span>${esc(a.name)}
      <input type="range" data-axis="${esc(a.tag)}" min="${a.min}" max="${a.max}" step="${a.max - a.min > 20 ? 1 : 0.1}" value="${T.axes[a.tag] ?? a.default}">
      <span class="val">${Math.round((T.axes[a.tag] ?? a.default) * 10) / 10}</span></label>`).join("") +
      (inst.length ? `<label>Instance <select class="sel" id="t-inst" style="height:30px"><option value="">—</option>${inst.map((x, i) => `<option value="${i}">${esc(x.name)}</option>`).join("")}</select></label>` : "") +
      `<button class="btn small ghost" data-act="axanim">▶ Animate</button>`;
  };
  renderAxes();
  applyTester();
  $("#t-face")?.addEventListener("change", (e) => { T.face = e.target.value; T.axes = {}; renderAxes(); applyTester(); });
  const bindRange = (id, k, fmt = (v) => v) => $(id).addEventListener("input", (e) => { T[k] = Number(e.target.value); $(id + "-v").textContent = fmt(T[k]); applyTester(); });
  bindRange("#t-size", "size");
  bindRange("#t-lh", "lh");
  bindRange("#t-ls", "ls", (v) => v.toFixed(3));
  $(".tester-ctl").addEventListener("click", (e) => {
    const a = e.target.closest("[data-align]");
    if (a) { T.align = a.dataset.align; $$("[data-align]").forEach((b) => b.classList.toggle("on", b === a)); applyTester(); }
    const s = e.target.closest("[data-sw]");
    if (s) { T.sw = Number(s.dataset.sw); $$("[data-sw]").forEach((b) => b.classList.toggle("on", b === s)); applyTester(); }
  });
  let animRaf = null;
  $("#t-axes").addEventListener("input", (e) => {
    const r = e.target.closest("[data-axis]");
    if (r) { T.axes[r.dataset.axis] = Number(r.value); r.nextElementSibling.textContent = Math.round(r.value * 10) / 10; applyTester(); }
  });
  $("#t-axes").addEventListener("change", (e) => {
    if (e.target.id !== "t-inst" || e.target.value === "") return;
    const inst = faceById(T.face).axes.instances[Number(e.target.value)];
    Object.assign(T.axes, inst.coords);
    renderAxes(); applyTester();
  });
  $("#t-axes").addEventListener("click", (e) => {
    if (!e.target.closest("[data-act=axanim]")) return;
    if (animRaf) { cancelAnimationFrame(animRaf); animRaf = null; e.target.textContent = "▶ Animate"; return; }
    e.target.textContent = "■ Stop";
    const axs = axesOf(faceById(T.face));
    const t0 = performance.now();
    const step = (t) => {
      if (!document.body.contains(area)) return;
      axs.forEach((a, i) => {
        const ph = ((t - t0) / (2600 + i * 900)) * Math.PI * 2;
        T.axes[a.tag] = a.min + (a.max - a.min) * (0.5 - 0.5 * Math.cos(ph));
        const r = $(`[data-axis="${CSS.escape(a.tag)}"]`);
        if (r) { r.value = T.axes[a.tag]; r.nextElementSibling.textContent = Math.round(T.axes[a.tag]); }
      });
      applyTester();
      animRaf = requestAnimationFrame(step);
    };
    animRaf = requestAnimationFrame(step);
  });
  $("#t-feats")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-feat]");
    if (!b) return;
    const t = b.dataset.feat;
    T.feats.has(t) ? T.feats.delete(t) : T.feats.add(t);
    b.classList.toggle("on", T.feats.has(t));
    applyTester();
  });
  area.addEventListener("input", () => {
    const txt = area.innerText.trim();
    $$("#styles .sp, #wf [data-face]").forEach((el) => { el.textContent = txt; });
  });

  // ---- glyphs
  let chars = [], gshow = 480, gsel = null, gface = rep.id;
  const big = $("#g-big");
  const loadGlyphs = async () => {
    chars = await api(`/api/face/${enc(gface)}/chars`).catch(() => []);
    gshow = 480;
    $("#g-grid").style.fontFamily = ff(gface);
    loadFace(gface).then(() => { big.style.fontFamily = ff(gface); });
    drawGlyphs();
  };
  const drawGlyphs = () => {
    const q = $("#g-q").value.trim();
    let list = chars;
    if (q) {
      const hex = q.replace(/^u\+/i, "");
      list = chars.filter((c) => String.fromCodePoint(c) === q || (/^[0-9a-f]{2,6}$/i.test(hex) && c.toString(16).toUpperCase().includes(hex.toUpperCase())));
    }
    $("#g-count").textContent = q ? `${list.length} match${list.length === 1 ? "" : "es"}` : `${chars.length.toLocaleString()} characters`;
    $("#g-grid").innerHTML = list.slice(0, gshow).map((c) => `<button data-cp="${c}" class="${c === gsel ? "sel" : ""}" title="U+${c.toString(16).toUpperCase().padStart(4, "0")}">${esc(String.fromCodePoint(c))}</button>`).join("");
    $("#g-more").innerHTML = list.length > gshow ? `<button class="btn small" id="g-all">Show all ${list.length.toLocaleString()}</button>` : "";
  };
  const pickGlyph = (c) => {
    gsel = c;
    big.textContent = String.fromCodePoint(c);
    const hex = c.toString(16).toUpperCase().padStart(4, "0");
    $("#g-code").innerHTML = `U+${hex} · ${c} · <span style="user-select:all">&amp;#x${hex};</span>`;
    $$("#g-grid button").forEach((b) => b.classList.toggle("sel", Number(b.dataset.cp) === c));
  };
  $("#g-grid").addEventListener("click", (e) => { const b = e.target.closest("[data-cp]"); if (b) pickGlyph(Number(b.dataset.cp)); });
  $("#g-grid").addEventListener("dblclick", (e) => { const b = e.target.closest("[data-cp]"); if (b) copy(String.fromCodePoint(Number(b.dataset.cp)), `Copied “${String.fromCodePoint(Number(b.dataset.cp))}”`); });
  $("#g-more").addEventListener("click", (e) => { if (e.target.id === "g-all") { gshow = 1e9; drawGlyphs(); } });
  $("#g-q").addEventListener("input", debounce(drawGlyphs, 120));
  $("#g-face")?.addEventListener("change", (e) => { gface = e.target.value; loadGlyphs(); });
  $("#g-copy").addEventListener("click", () => { if (gsel !== null) copy(String.fromCodePoint(gsel), `Copied “${String.fromCodePoint(gsel)}”`); });
  loadGlyphs().then(() => { const a = chars.find((c) => c === 0x26) ?? chars.find((c) => c === 0x41) ?? chars[0]; if (a !== undefined) pickGlyph(a); });

  // ---- pairing
  let heading = f.key, body = null;
  const suggest = () => {
    const self = S.byKey.get(f.key) || f;
    const want = { serif: ["sans"], display: ["sans", "serif"], script: ["sans", "serif"], sans: ["serif", "sans"], mono: ["sans"], other: ["sans", "serif"] }[self.category] || ["sans"];
    const pool = others.filter((x) => want.includes(x.category) && x.scripts.includes("Latin"));
    const pick = (pool.length ? pool : others)[Math.floor(Math.random() * (pool.length || others.length))];
    return pick ? pick.key : null;
  };
  const drawPair = () => {
    const H = heading === f.key ? { name: f.name, rep: f.rep } : S.byKey.get(heading);
    const B = body === f.key ? { name: f.name, rep: f.rep } : S.byKey.get(body);
    if (!H || !B) { $("#p-body").innerHTML = "<p>Add more fonts to try pairings.</p>"; return; }
    $("#p-role").innerHTML = heading === f.key ? `${esc(f.name)} as <b>heading</b>, with body` : `${esc(f.name)} as <b>body</b>, with heading`;
    $("#p-body").innerHTML = `<div class="kicker" data-face="${esc(B.rep)}">${esc(H.name)} + ${esc(B.name)}</div>
      <h3 data-face="${esc(H.rep)}">Good type is invisible until it isn't</h3>
      <p data-face="${esc(B.rep)}">Typography is the craft of endowing human language with a durable visual form. Pair a confident display face with a calm, readable text face and let each do the job it was drawn for. The heading sets the tone; the body carries the reader through.</p>
      <p data-face="${esc(B.rep)}">Numbers 0123456789, punctuation “quotes”, (brackets) & ampersands — all set in the body face at reading size.</p>`;
    observeFaces($("#p-body"));
  };
  body = suggest();
  if (body) $("#p-with").value = body;
  drawPair();
  $("#p-with").addEventListener("change", (e) => { if (heading === f.key) body = e.target.value; else heading = e.target.value; drawPair(); });
  $("#pairing").addEventListener("click", (e) => {
    if (e.target.closest("[data-act=pairshuffle]")) {
      const k = suggest();
      if (heading === f.key) body = k; else heading = k;
      $("#p-with").value = k;
      drawPair();
    }
    if (e.target.closest("[data-act=pairswap]")) { [heading, body] = [body, heading]; drawPair(); }
  });

  // ---- notes
  const saveNote = debounce(async () => {
    await api(`/api/note/${enc(f.key)}`, { json: { note: $("#note").value } });
    const fam = S.byKey.get(f.key);
    if (fam) { fam.note = $("#note").value; fam._s += " " + fam.note.toLowerCase(); }
    $("#note-state").textContent = "Saved.";
  }, 700);
  $("#note").addEventListener("input", () => { $("#note-state").textContent = "Saving…"; saveNote(); });

  // ---- header actions
  $(".fam").addEventListener("click", (e) => {
    const a = e.target.closest("[data-act]");
    if (a?.dataset.act === "catmenu") {
      showMenu(a, [{ lbl: "File under" }, ...CATS.map(([c, l]) => ({ check: f.category === c, label: l + (f.category_auto === c ? " (auto)" : ""), run: () => setCategory(f.key, c === f.category_auto ? "" : c) }))]);
    }
    if (a?.dataset.act === "fammore") {
      const fam = S.byKey.get(f.key);
      showMenu(a, [{ lbl: "Collections" },
        ...S.collections.map((c) => ({ check: fam.collections.includes(c.id), label: c.name, run: () => toggleCollection(c.id, f.key) })),
        { icon: ICON.plus, label: "New collection…", run: () => newCollection(f.key) }]);
    }
    if (a?.dataset.act === "pickfam") { togglePick(f.key); a.innerHTML = `${ICON.compare} ${S.picks.includes(f.key) ? "In compare" : "Compare"}`; }
    if (a?.dataset.act === "specimen") exportSpecimen(f);
    if (e.target.closest("[data-jump]")) {
      e.preventDefault();
      $(e.target.closest("[data-jump]").getAttribute("href")).scrollIntoView({ behavior: "smooth" });
    }
  });
  scrollTo(0, 0);
}
function safeUrl(u) {
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^www\./i.test(s)) return "https://" + s;
  return "#";
}

// ------------------------------------------------------------------ specimen PNG
async function exportSpecimen(f) {
  const t = toast("Setting the specimen…", { sticky: true });
  const faces = f.faces.slice(0, 12);
  await Promise.all(faces.map((x) => loadFace(x.id)));
  await document.fonts.ready;
  const W = 1600, P = 90;
  const c = document.createElement("canvas");
  const lines = [];
  const css = getComputedStyle(document.documentElement);
  const paper = "#f5f0e6", ink = "#17140f", accent = css.getPropertyValue("--accent").trim() || "#ff4a1c", muted = "#7a7064";
  const fam = (id) => `'tc-${id}'`;
  const rep = f.rep;
  const sample = SAMPLES[f.category] || SAMPLES.other;
  // measure height first
  const plan = [
    { h: 70, draw: (g, y) => { g.fillStyle = accent; g.font = "600 22px ui-monospace, Consolas, monospace"; g.fillText(`${CAT_LABEL[f.category].toUpperCase()} · ${f.styles} STYLE${f.styles > 1 ? "S" : ""}${f.variable ? " · VARIABLE" : ""}`, P, y + 30); } },
    { h: 190, draw: (g, y) => { g.fillStyle = ink; g.font = `150px ${fam(rep)}`; fitText(g, f.name, P, y + 150, W - 2 * P, 150, fam(rep)); } },
    { h: 70, draw: (g, y) => { g.fillStyle = muted; g.font = "26px ui-sans-serif, system-ui, Segoe UI, sans-serif"; g.fillText([f.designer && `Designed by ${f.designer}`, f.foundry !== f.designer && f.foundry].filter(Boolean).join(" · ").slice(0, 110), P, y + 34); } },
    { h: 330, draw: (g, y) => {
      g.fillStyle = ink; g.font = `300px ${fam(rep)}`; g.fillText("Aa", P - 8, y + 270);
      g.font = `54px ${fam(rep)}`;
      g.fillText("ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, 26), 640, y + 90, W - 640 - P);
      g.fillText("abcdefghijklmnopqrstuvwxyz", 640, y + 170, W - 640 - P);
      g.fillText("0123456789 &@?!%€£₹", 640, y + 250, W - 640 - P);
    } },
    ...faces.map((x) => ({ h: 92, draw: (g, y) => {
      g.strokeStyle = "#ddd3c2"; g.beginPath(); g.moveTo(P, y + 4); g.lineTo(W - P, y + 4); g.stroke();
      g.fillStyle = muted; g.font = "20px ui-monospace, Consolas, monospace"; g.fillText(`${x.style}`.slice(0, 22), P, y + 58);
      g.fillStyle = ink; g.font = `52px ${fam(x.id)}`; fitText(g, sample, P + 300, y + 66, W - 2 * P - 300, 52, fam(x.id));
    } })),
    { h: 330, draw: (g, y) => {
      g.fillStyle = ink; g.font = `30px ${fam(rep)}`;
      wrap(g, "Typography is the craft of endowing human language with a durable visual form. A good typeface disappears into the reading; a great one makes you stop and look. This sheet shows the family at display and text sizes so you can judge both.", P, y + 70, W - 2 * P, 46);
    } },
    { h: 70, draw: (g, y) => { g.fillStyle = muted; g.font = "20px ui-monospace, Consolas, monospace"; g.fillText(`${APP_NAME.toUpperCase()} · ${new Date().toLocaleDateString()}`, P, y + 40); } },
  ];
  const H = plan.reduce((a, b) => a + b.h, 0) + P * 1.5;
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = paper; g.fillRect(0, 0, W, H);
  g.fillStyle = accent; g.fillRect(0, 0, W, 14);
  let y = P * 0.8;
  for (const p of plan) { p.draw(g, y); y += p.h; }
  c.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${f.name} specimen.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    t.kill();
    toast("Specimen saved as PNG");
  }, "image/png");
  lines.length = 0;
}
function fitText(g, text, x, y, maxW, size, fam) {
  let s = size;
  g.font = `${s}px ${fam}`;
  while (g.measureText(text).width > maxW && s > 12) { s -= 4; g.font = `${s}px ${fam}`; }
  g.fillText(text, x, y);
}
function wrap(g, text, x, y, maxW, lh) {
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? line + " " + w : w;
    if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); y += lh; line = w; } else line = t;
  }
  if (line) g.fillText(line, x, y);
}

// ------------------------------------------------------------------ compare
function comparePage() {
  renderTray();
  const fams = S.picks.map((k) => S.byKey.get(k)).filter(Boolean);
  const size = store.get("cmpsize", 48);
  $("#view").innerHTML = `
    <div class="cmp-head"><h1>Compare</h1><span style="color:var(--muted);font-size:14px">${fams.length ? `${plural(fams.length, "font")} side by side` : ""}</span></div>
    <div class="tool-row" style="margin-top:6px">
      <label class="field sample"><input id="c-text" placeholder="Type to compare…" value="${esc(S.text || "Handgloves & Hamburgefonstiv 0123")}"></label>
      <label class="size-ctl"><span>Aa</span><input type="range" id="c-size" min="14" max="160" value="${size}"><span id="c-size-v">${size}px</span></label>
      <button class="btn" data-act="cmpadd">${ICON.plus} Add font</button>
      ${fams.length ? `<button class="btn ghost" data-act="clearpicks">Clear</button>` : ""}
    </div>
    <div class="cmp-rows" id="c-rows">${fams.length ? fams.map((f) => `<div class="cmp-row c-${f.category}">
      <header><a href="#/f/${enc(f.key)}">${esc(f.name)}</a><span class="tag">${CAT_LABEL[f.category]}</span><span style="color:var(--muted)">${esc(f.designer || "")}</span>
        <button class="icon-btn" data-unpick="${esc(f.key)}" title="Remove">${ICON.x}</button></header>
      <div class="specimen" data-face="${esc(f.rep)}" style="font-size:${size}px">${esc(S.text || "Handgloves & Hamburgefonstiv 0123")}</div></div>`).join("")
      : `<div class="empty"><div class="big">⇆</div><h2>Nothing to compare yet</h2><p>Click the ${ICON.compare.replace('class="i"', 'class="i" style="vertical-align:-3px"')} button on up to 8 fonts in the library, or add one here.</p></div>`}</div>`;
  observeFaces($("#view"));
  $("#c-text").addEventListener("input", (e) => $$("#c-rows .specimen").forEach((el) => { el.textContent = e.target.value; }));
  $("#c-size").addEventListener("input", (e) => {
    $("#c-size-v").textContent = `${e.target.value}px`;
    store.set("cmpsize", Number(e.target.value));
    $$("#c-rows .specimen").forEach((el) => { el.style.fontSize = `${e.target.value}px`; });
  });
}

// ------------------------------------------------------------------ health
async function healthPage() {
  $("#view").innerHTML = `<div class="health"><h1>Duplicates & issues</h1><p style="color:var(--muted)">Loading…</p></div>`;
  const dups = await api("/api/duplicates");
  const broken = S.lib.broken;
  const wasted = dups.reduce((a, d) => a + d.size * (d.paths.length - 1), 0);
  $("#view").innerHTML = `<div class="health">
    <h1>Duplicates & issues</h1>
    <p style="color:var(--muted);max-width:70ch">Identical files are shown once in the library. Nothing is deleted here: tidy up in the fonts folder (Samba or File Browser), then hit <b>Rescan</b>.</p>
    <h2 style="font-size:18px;margin-top:26px">Identical files <span class="tag plain">${dups.length} group${dups.length === 1 ? "" : "s"} · ${fmtBytes(wasted)} reclaimable</span></h2>
    ${dups.length ? `<table><tr><th>Family</th><th>Copies</th><th>Size</th></tr>${dups.map((d) => `<tr><td>${d.family ? `<a href="#/f/${enc(slugify(d.family))}">${esc(d.family)}</a>` : "—"}</td>
      <td>${d.paths.map((p, i) => `<div><code>${esc(p)}</code>${i === 0 ? ' <span class="tag plain">kept</span>' : ""}</div>`).join("")}</td><td>${fmtBytes(d.size)}</td></tr>`).join("")}</table>`
      : `<p>No duplicate files. Tidy!</p>`}
    <h2 style="font-size:18px;margin-top:30px">Files that couldn't be read <span class="tag plain">${broken.length}</span></h2>
    ${broken.length ? `<table><tr><th>File</th><th>Problem</th></tr>${broken.map((b) => `<tr><td><code>${esc(b.path)}</code></td><td>${esc(b.error)}</td></tr>`).join("")}</table>` : "<p>Every file opened fine.</p>"}
  </div>`;
}
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled";

// ------------------------------------------------------------------ command palette
const pal = { items: [], sel: 0, pick: false };
function openPalette(prefill = "", pick = false) {
  closeMenu();
  pal.pick = pick;
  $("#palette-input").placeholder = pick ? "Add a font to the comparison…" : "Jump to a font, collection or action…";
  $("#palette").hidden = false;
  const inp = $("#palette-input");
  inp.value = prefill;
  inp.focus();
  drawPalette();
}
function closePalette() { $("#palette").hidden = true; }
function paletteCommands() {
  return [
    { label: "Add fonts…", hint: "upload", run: () => $("#file-input").click() },
    { label: "Surprise me", hint: "random font", run: surprise },
    { label: `Switch to ${document.documentElement.dataset.mode === "dark" ? "light" : "dark"} theme`, hint: "d", run: toggleDark },
    { label: "Settings", hint: ",", run: () => { location.hash = "#/settings"; } },
    ...THEMES.map((t) => ({ label: `Theme: ${t.name}`, hint: t.mode, run: () => pickTheme(t.id) })),
    { label: "All fonts", hint: "go", run: () => { location.hash = "#/"; } },
    { label: "Favourites", hint: "go", run: () => { location.hash = "#/fav"; } },
    { label: "Recently added", hint: "go", run: () => { location.hash = "#/recent"; } },
    { label: "Compare", hint: "go", run: () => { location.hash = "#/compare"; } },
    { label: "Duplicates & issues", hint: "go", run: () => { location.hash = "#/health"; } },
    { label: "New collection…", hint: "create", run: () => newCollection() },
    { label: "Rescan fonts folder", hint: "index", run: rescan },
    ...S.collections.map((c) => ({ label: `Collection: ${c.name}`, hint: `${c.count} fonts`, run: () => { location.hash = `#/c/${c.id}`; } })),
  ];
}
function drawPalette() {
  const q = $("#palette-input").value.trim().toLowerCase();
  const fams = (q ? S.families.filter((f) => f._s.includes(q)) : S.families.filter((f) => f.favorite).concat(S.families).slice(0, 0))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 30);
  const cmds = paletteCommands().filter((c) => !q || c.label.toLowerCase().includes(q));
  const famRun = (f) => pal.pick ? () => { if (!S.picks.includes(f.key)) togglePick(f.key); } : () => { location.hash = `#/f/${enc(f.key)}`; };
  pal.items = [...fams.map((f) => ({ fam: f, run: famRun(f) })), ...(pal.pick ? [] : cmds)];
  pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
  if (!q) pal.sel = 0;
  $("#palette-list").innerHTML = pal.items.map((it, i) => it.fam
    ? `<div class="it ${i === pal.sel ? "sel" : ""}" data-i="${i}"><span class="pv" data-face="${esc(it.fam.rep)}">Aa</span><span>${esc(it.fam.name)}</span><span class="hint">${esc(CAT_LABEL[it.fam.category])} · ${it.fam.styles}</span></div>`
    : `<div class="it ${i === pal.sel ? "sel" : ""}" data-i="${i}"><span class="pv" style="font-size:15px;opacity:.6">→</span><span>${esc(it.label)}</span><span class="hint">${esc(it.hint)}</span></div>`).join("")
    || `<div style="padding:16px;color:var(--muted)">No matches.</div>`;
  $$("#palette-list [data-face]").forEach((el) => applyFace(el, el.dataset.face));
}
function runPalette(i) {
  const it = pal.items[i];
  closePalette();
  if (it) it.run();
}

// ------------------------------------------------------------------ uploads
async function uploadFiles(files) {
  if (DEMO) { demoReadOnly(); return; }
  if (S.lib && S.lib.uploads === false) { toast("Uploads are turned off on this server. Add fonts to the fonts folder and rescan."); return; }
  const list = [...files].filter((f) => /\.(ttf|otf|woff2?|ttc|otc|zip)$/i.test(f.name));
  if (!list.length) { toast("Those don't look like font files (.ttf .otf .woff .woff2 .ttc .zip)."); return; }
  const t = toast("", { sticky: true, raw: true });
  const results = [];
  for (let i = 0; i < list.length; i++) {
    t.set(`Adding <b>${esc(list[i].name)}</b> (${i + 1}/${list.length})<div class="prog"><i style="width:${(100 * i) / list.length}%"></i></div>`);
    try {
      const r = await fetch(`api/upload?name=${enc(list[i].name)}`, { method: "PUT", body: list[i] });
      const j = await r.json().catch(() => ({}));
      results.push(...(j.results || [{ name: list[i].name, status: "rejected", reason: j.error || r.statusText }]));
    } catch (e) {
      results.push({ name: list[i].name, status: "rejected", reason: e.message });
    }
  }
  const added = results.filter((r) => r.status === "added");
  const dup = results.filter((r) => r.status === "duplicate");
  const bad = results.filter((r) => r.status === "rejected" || r.status === "skipped");
  const fams = [...new Set(added.map((r) => r.key))];
  await loadLibrary();
  render();
  t.set(`<b>${added.length ? `Added ${plural(added.length, "font")}` : "No new fonts"}</b>${fams.length ? ` in ${plural(fams.length, "family")}` : ""}.
    ${dup.length ? ` ${dup.length} already in your case.` : ""}${bad.length ? ` ${bad.length} skipped.` : ""}
    ${fams.length === 1 ? ` <a data-go="${esc(fams[0])}">Open ${esc(added[0].family)}</a>` : ""}
    ${bad.length || dup.length ? `<ul>${[...bad.map((r) => `<li>${esc(r.name)}: ${esc(r.reason || r.status)}</li>`), ...dup.slice(0, 8).map((r) => `<li>${esc(r.name)}: already there (${esc(r.path)})</li>`)].join("")}</ul>` : ""}`);
  t.el.addEventListener("click", (e) => { const a = e.target.closest("[data-go]"); if (a) { location.hash = `#/f/${enc(a.dataset.go)}`; t.kill(); } });
  setTimeout(t.kill, bad.length || dup.length ? 9000 : 5000);
  if (added.length) confetti();
}
function confetti() {
  const pool = S.families.filter((f) => f.scripts.includes("Latin"));
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("span");
    const f = pool[Math.floor(Math.random() * pool.length)];
    s.textContent = "AaGgRr&?!Qz"[Math.floor(Math.random() * 11)];
    if (f) s.style.fontFamily = ff(f.rep);
    Object.assign(s.style, {
      position: "fixed", left: `${50 + (Math.random() - .5) * 30}%`, top: "60%", fontSize: `${24 + Math.random() * 40}px`, zIndex: 120, pointerEvents: "none",
      color: ["var(--accent)", "var(--blue)", "var(--green)", "var(--purple)", "var(--pink)", "var(--yellow)"][i % 6],
      transition: "transform 1.2s cubic-bezier(.2,.8,.3,1), opacity 1.2s ease-in",
    });
    document.body.appendChild(s);
    requestAnimationFrame(() => {
      s.style.transform = `translate(${(Math.random() - .5) * 700}px, ${-200 - Math.random() * 400}px) rotate(${(Math.random() - .5) * 720}deg)`;
      s.style.opacity = "0";
    });
    setTimeout(() => s.remove(), 1300);
  }
}

// ------------------------------------------------------------------ misc actions
function surprise() {
  const pool = S.families;
  if (!pool.length) return;
  location.hash = `#/f/${enc(pool[Math.floor(Math.random() * pool.length)].key)}`;
}
async function rescan() {
  if (DEMO) { toast("The demo library is a fixed set of free Google Fonts."); return; }
  await api("/api/rescan", { method: "POST" });
  toast("Rescanning the fonts folder…");
  const poll = async () => {
    const s = await api("/api/scan");
    S.lib.scan = s;
    renderSide();
    if (s.scanning) setTimeout(poll, 700);
    else { await loadLibrary(); render(); toast("Library is up to date"); }
  };
  setTimeout(poll, 500);
}

// ------------------------------------------------------------------ events
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu") && !e.target.closest("[data-act=more],[data-act=catmenu],[data-act=fammore]")) closeMenu();
  const unp = e.target.closest("[data-unpick]");
  if (unp) { togglePick(unp.dataset.unpick); return; }
  const act = e.target.closest("[data-act]");
  const card = e.target.closest(".card");
  if (act) {
    const a = act.dataset.act;
    const key = card?.dataset.key;
    if (a === "dl") return; // plain link
    e.preventDefault();
    if (a === "fav" && key) toggleFav(key);
    else if (a === "famfav") toggleFav(act.dataset.famfav);
    else if (a === "more" && key) familyMenu(key, act);
    else if (a === "pick" && key) togglePick(key);
    else if (a === "surprise") surprise();
    else if (a === "newcoll") newCollection();
    else if (a === "rescan") rescan();
    else if (a === "upload") $("#file-input").click();
    else if (a === "clear") { S.q = ""; S.cat = "all"; S.vf = S.ital = false; S.script = ""; gallery(S.scope); }
    else if (a === "clearpicks") { S.picks = []; store.set("picks", []); renderTray(); renderSide(); if (route().name === "compare") comparePage(); else $$(".card.picked").forEach((c) => { c.classList.remove("picked"); $("[data-act=pick]", c).classList.remove("on"); }); }
    else if (a === "cmpadd") openPalette("", true);
    else if (a === "renamecoll") renameCollection();
    else if (a === "delcoll") deleteCollection();
    return;
  }
  if (card && !e.target.closest("a,button,input")) location.hash = `#/f/${enc(card.dataset.key)}`;
  const chip = e.target.closest("[data-cat]");
  if (chip) { S.cat = chip.dataset.cat; refreshGallery(); }
  const flag = e.target.closest("[data-flag]");
  if (flag) { S[flag.dataset.flag] = !S[flag.dataset.flag]; refreshGallery(); }
  const vb = e.target.closest("[data-view]");
  if (vb) {
    S.view = vb.dataset.view; store.set("view", S.view);
    $$("[data-view]").forEach((b) => b.classList.toggle("on", b === vb));
    $("#grid").classList.toggle("list", S.view === "list");
  }
  const pre = e.target.closest("[data-preset]");
  if (pre) {
    S.text = PRESETS[Number(pre.dataset.preset)][1];
    store.set("text", S.text);
    $("#sample").value = S.text;
    updateSpecimens();
  }
  const pi = e.target.closest("#palette-list [data-i]");
  if (pi) runPalette(Number(pi.dataset.i));
  if (e.target.id === "palette") closePalette();
});
document.addEventListener("input", (e) => {
  const id = e.target.id;
  if (id === "q") { S.q = e.target.value; debouncedRefresh(); }
  if (id === "sample") { S.text = e.target.value; store.set("text", S.text); updateSpecimens(); }
  if (id === "size") {
    S.size = Number(e.target.value); store.set("size", S.size);
    $("#size-v").textContent = `${S.size}px`;
    $("#grid").style.setProperty("--sz", `${S.size}px`);
  }
  if (id === "palette-input") { pal.sel = 0; drawPalette(); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "sort") { S.sort = e.target.value; store.set("sort", S.sort); S.seed = Math.random(); refreshGallery(); }
  if (e.target.id === "script") { S.script = e.target.value; refreshGallery(); }
  if (e.target.id === "file-input") { uploadFiles(e.target.files); e.target.value = ""; }
});
const debouncedRefresh = debounce(() => refreshGallery(), 140);
document.addEventListener("mouseover", (e) => {
  const card = e.target.closest?.("#grid .card");
  if (card) hoverStart(card); else if (hoverCard) hoverStop();
});
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette(); return; }
  if (!$("#palette").hidden) {
    if (e.key === "Escape") closePalette();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      pal.sel = (pal.sel + (e.key === "ArrowDown" ? 1 : -1) + pal.items.length) % Math.max(1, pal.items.length);
      $$("#palette-list .it").forEach((el, i) => el.classList.toggle("sel", i === pal.sel));
      $("#palette-list .it.sel")?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") { e.preventDefault(); runPalette(pal.sel); }
    return;
  }
  if (e.key === "Escape") {
    if (!$("#theme-panel").hidden) $("#theme-panel").hidden = true;
    else if (!$("#menu").hidden) closeMenu();
    else if (route().name === "family") history.length > 1 ? history.back() : (location.hash = "#/");
    else if (document.activeElement?.id === "q") document.activeElement.blur();
  }
  if (typing) return;
  if (e.key === "/" && $("#q")) { e.preventDefault(); $("#q").focus(); }
  if (e.key === "d" && !e.ctrlKey && !e.metaKey) toggleDark();
  if (e.key === "," && !e.ctrlKey && !e.metaKey) location.hash = "#/settings";
});
$("#cmdk-btn").addEventListener("click", () => openPalette());
$("#theme-btn").addEventListener("click", openThemePanel);
$("#upload-btn").innerHTML = `${ICON.plus}<span class="lbl-long">Add fonts</span>`;
$("#upload-btn").addEventListener("click", () => $("#file-input").click());
$("#wordmark").addEventListener("click", () => shuffleWordmark(true));

// drag & drop anywhere
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragDepth++ === 0) {
    $("#drop").hidden = false;
    const f = S.families[Math.floor(Math.random() * S.families.length)];
    if (f) applyFace($("#drop-glyphs"), f.rep);
  }
});
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("#drop").hidden = true;
  uploadFiles(e.dataTransfer.files);
});

async function renameCollection() {
  const r = route();
  const c = S.collections.find((x) => x.id === r.id);
  if (!c) return;
  const name = await askText("Rename collection", "Name", c.name);
  if (!name || name === c.name) return;
  try { await api(`/api/collections/${c.id}/rename`, { json: { name } }); } catch (e) { toast(e.message); return; }
  await loadLibrary(); render();
}
async function deleteCollection() {
  const r = route();
  const c = S.collections.find((x) => x.id === r.id);
  if (!c) return;
  const ok = await askText(`Delete “${c.name}”? Fonts stay in the library. Type DELETE to confirm.`, "DELETE");
  if (ok !== "DELETE") return;
  await api(`/api/collections/${c.id}/delete`, { method: "POST" });
  await loadLibrary();
  location.hash = "#/";
  toast(`Collection “${c.name}” deleted`);
}

// ------------------------------------------------------------------ settings
const PREF_KEYS = ["tc.themeMode", "tc.themeLight", "tc.themeDark", "tc.theme", "tc.text", "tc.size", "tc.view", "tc.sort", "tc.picks", "tc.cmpsize"];
function settingsPage() {
  const st = S.lib.stats;
  const scan = S.lib.scan;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
  const keys = [[["/"], "Search the library"], [[mod, "K"], "Jump to a font, collection or action"], [["d"], "Switch between your light and dark theme"],
    [[","], "Open settings"], [["Esc"], "Close a menu, or go back from a font"], [["↑", "↓", "↵"], "Move and pick in the command bar"]];
  $("#view").innerHTML = `<div class="settings">
    <div class="cmp-head"><h1>Settings</h1><span style="color:var(--muted);font-size:14px">Preferences are saved in this browser</span></div>

    <section class="set-sec" id="appearance"><h2>// appearance</h2>${themePickerHTML()}</section>

    <section class="set-sec"><h2>// preview defaults</h2>
      <div class="set-rows">
        <label class="set-row"><span>Sample text<small>Empty uses a pangram that suits each category</small></span>
          <input class="set-input" id="set-text" placeholder="Category pangrams" value="${esc(S.text)}" autocomplete="off"></label>
        <label class="set-row"><span>Preview size</span>
          <span class="set-ctl"><input type="range" id="set-size" min="14" max="140" value="${S.size}"><code id="set-size-v">${S.size}px</code></span></label>
        <div class="set-row"><span>Layout</span>
          <div class="seg" role="group" aria-label="Layout">${[["grid", ICON.grid, "Grid"], ["list", ICON.list, "List"]].map(([v, ic, l]) =>
            `<button type="button" data-set-view="${v}" class="${S.view === v ? "on" : ""}" title="${l}">${ic}</button>`).join("")}</div></div>
        <label class="set-row"><span>Sort fonts by</span>
          <select class="sel" id="set-sort">${[["az", "A → Z"], ["new", "Newest"], ["styles", "Most styles"], ["shuffle", "Shuffle"]].map(([v, l]) =>
            `<option value="${v}" ${S.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
    </section>

    <section class="set-sec"><h2>// keyboard</h2>
      <dl class="set-keys">${keys.map(([ks, what]) => `<div><dt>${ks.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</dt><dd>${esc(what)}</dd></div>`).join("")}</dl>
    </section>

    <section class="set-sec"><h2>// ${DEMO ? "this demo" : "this server"}</h2>
      <dl class="kv set-kv">
        <dt>Version</dt><dd><code>v${esc(S.lib.version || "?")}</code></dd>
        <dt>Library</dt><dd>${plural(st.families, "family")} · ${plural(st.faces, "style")} · ${fmtBytes(st.bytes)}</dd>
        <dt>Files</dt><dd>${plural(st.files, "file")}${st.duplicates ? ` · <a href="#/health">${plural(st.duplicates, "duplicate")}</a>` : ""}${st.broken ? ` · <a href="#/health">${st.broken} unreadable</a>` : ""}</dd>
        <dt>Uploads</dt><dd>${DEMO ? "Off in the demo" : S.lib.uploads === false ? "Off (<code>TYPESTASH_UPLOADS=false</code>)" : "On"}</dd>
        <dt>Index</dt><dd>${scan.scanning ? `Indexing ${scan.done} / ${scan.total}…` : scan.last ? `Updated ${timeAgo(scan.last)}` : "—"}</dd>
      </dl>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        <button class="btn small" data-act="rescan">${ICON.refresh} Rescan fonts folder</button>
        <a class="btn small ghost" href="#/health">${ICON.alert} Duplicates & issues</a>
      </div>
    </section>

    <section class="set-sec"><h2>// reset</h2>
      <p class="set-note">Clears the theme, preview and compare preferences saved in this browser. Fonts, favourites, collections and notes live ${DEMO ? "in the demo's own storage" : "on the server"} and aren't touched.</p>
      <button class="btn small" data-act="resetprefs">${ICON.trash} Reset preferences</button>
    </section>
  </div>`;
  if (location.hash.endsWith("#appearance")) $("#appearance").scrollIntoView();
}
document.addEventListener("input", (e) => {
  if (e.target.id === "set-text") { S.text = e.target.value; store.set("text", S.text); }
  if (e.target.id === "set-size") { S.size = Number(e.target.value); store.set("size", S.size); $("#set-size-v").textContent = `${S.size}px`; }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "set-sort") { S.sort = e.target.value; store.set("sort", S.sort); toast("Sort order saved"); }
});
document.addEventListener("click", (e) => {
  const v = e.target.closest("[data-set-view]");
  if (v) {
    S.view = v.dataset.setView; store.set("view", S.view);
    $$("[data-set-view]").forEach((b) => b.classList.toggle("on", b === v));
  }
  const r = e.target.closest("[data-act=resetprefs]");
  if (r) {
    if (!r.dataset.armed) { r.dataset.armed = "1"; r.innerHTML = `${ICON.trash} Click again to reset`; setTimeout(() => { if (document.body.contains(r)) { delete r.dataset.armed; r.innerHTML = `${ICON.trash} Reset preferences`; } }, 4000); return; }
    PREF_KEYS.forEach((k) => { try { localStorage.removeItem(k); } catch { /* */ } });
    location.reload();
  }
});

// ------------------------------------------------------------------ boot
(async function boot() {
  document.title = DEMO ? `${APP_NAME} · live demo` : APP_NAME;
  if (DEMO) {
    document.body.insertAdjacentHTML("afterbegin", `<div class="demo-bar"><b>Live demo</b> with free Google Fonts. Favourites, notes and collections stay in your browser.
      <a href="${REPO}" target="_blank" rel="noopener">Self-host it with one Docker command →</a></div>`);
  }
  applyTheme();
  try {
    await loadLibrary();
  } catch (e) {
    $("#view").innerHTML = `<div class="empty"><div class="big">!</div><h2>Can't reach the library</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  addEventListener("hashchange", render);
  render();
  // While the first index is still being built, keep refreshing.
  const watch = async () => {
    if (!S.lib.scan.scanning) return;
    const s = await api("/api/scan").catch(() => null);
    if (s && !s.scanning) { await loadLibrary(); render(); return; }
    if (s) { S.lib.scan = s; renderSide(); }
    setTimeout(watch, 1000);
  };
  watch();
})();
