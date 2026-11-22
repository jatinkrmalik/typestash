// Run the end-to-end suite against a throwaway Typestash server.
//
//   cd tests/e2e && npm install && npx playwright install chromium
//   node run.mjs
//
// It downloads the test fonts (once, cached in .work/cache), copies them into a
// fresh fonts folder, starts app/server.py on a free port with an empty data
// folder, runs e2e.mjs, and stops the server. Your real library is never touched.
// PYTHON picks the interpreter (default: python3, then python); it needs
// requirements.txt installed. GITHUB_TOKEN avoids the anonymous API limit.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const work = path.join(here, ".work");
const cache = path.join(work, "cache");
const py = process.env.PYTHON || (spawnSync("python3", ["--version"]).status === 0 ? "python3" : "python");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: repo, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

// 1. fonts (cached between runs)
console.log("Fetching test fonts…");
run(py, ["demo/fetch_fonts.py", path.join(here, "fonts.txt"), path.join(cache, "fonts")]);
run(py, ["demo/fetch_fonts.py", path.join(here, "uploads.txt"), path.join(cache, "uploads")]);

// 2. a fresh library and upload fixtures for this run
const fonts = path.join(work, "fonts"), data = path.join(work, "data"), up = path.join(work, "uploads");
for (const d of [fonts, data, up]) fs.rmSync(d, { recursive: true, force: true });
fs.cpSync(path.join(cache, "fonts"), fonts, { recursive: true });
fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(up, { recursive: true });
const u = path.join(cache, "uploads");
fs.copyFileSync(path.join(u, "youngserif", "YoungSerif-Regular.ttf"), path.join(up, "YoungSerif-Regular.ttf"));
fs.copyFileSync(path.join(u, "zeyada", "Zeyada.ttf"), path.join(up, "Zeyada.ttf"));
run(py, ["-c", "import sys,zipfile,glob,os; z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(f, os.path.basename(f)) for f in glob.glob(os.path.join(sys.argv[1],'*.ttf'))]; z.close()",
  path.join(u, "yellowtail"), path.join(up, "yellowtail.zip")]);
fs.writeFileSync(path.join(up, "notafont.ttf"), "not a font\n");

// 3. a throwaway server
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(py, ["-u", "app/server.py"], {
  cwd: repo, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, TYPESTASH_FONTS: fonts, TYPESTASH_DATA: data, TYPESTASH_BIND: "127.0.0.1", TYPESTASH_PORT: String(port), PYTHONIOENCODING: "utf-8", TYPESTASH_PASSWORD: "" },
});
let log = "";
server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
const stop = () => { try { server.kill(); } catch {} };
process.on("exit", stop);
for (let i = 0; ; i++) {
  if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
  if (i > 60 || server.exitCode !== null) { console.error(log); throw new Error("server did not start"); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`Server up on ${base}\n`);

// 4. the suite
const t = spawnSync(process.execPath, [path.join(here, "e2e.mjs"), base, up], { stdio: "inherit", cwd: here });
stop();
if (t.status !== 0) { console.error("\nServer log (last 40 lines):\n" + log.split("\n").slice(-40).join("\n")); }
process.exit(t.status ?? 1);
