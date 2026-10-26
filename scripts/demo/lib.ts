// Screen-recording helpers for the demo video: a Chromium window driven by Puppeteer, a terminal page that types
// real commands and prints their real output, and a narration timeline so the voice-over script is generated
// from the same steps that are recorded (each `say` holds the screen long enough to read the line aloud).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { CDPSession } from "puppeteer-core";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";

export const OUT = "docs/demo/out";
mkdirSync(OUT, { recursive: true });

const awsEnv = (() => {
  try { return Object.fromEntries(readFileSync(`${process.env.HOME}/.urumi-aws.env`, "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string])); } catch { return {} as Record<string, string>; }
})();
export const EIP = process.env.EIP ?? awsEnv.EIP ?? "";
export const DOMAIN = process.env.DOMAIN ?? EIP.replaceAll(".", "-") + ".sslip.io";
export const DASH = `dashboard.${DOMAIN}`;
export const SHOP = `shop.${DOMAIN}`;
const KEY = process.env.SSH_KEY ?? `${process.env.HOME}/.ssh/urumi-r1.pem`;
const WORDS_PER_SECOND = Number(process.env.WPS ?? 2.3);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs a command on the VPS (kubectl and helm are pointed at k3s) and returns combined output.
const PRE = "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml; cd ~/urumi; ";
export async function remote(command: string): Promise<string> {
  // The script goes over stdin so no local or remote shell re-parses its quotes and $(...) expansions.
  const proc = Bun.spawn(["ssh", "-i", KEY, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", `ubuntu@${EIP}`, "bash -s"], { stdin: new Blob([`${PRE}${command}\n`]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return (out + err).replace(/\r/g, "").replace(/Warning: Permanently added.*\n/, "");
}
export async function local(command: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return (out + err).replace(/\r/g, "");
}

export type Beat = { scene: string; at: number; say: string; seconds: number };
export const timeline: Beat[] = [];

const BROWSERS = [process.env.BROWSER_PATH, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean) as string[];

let browser: Browser | undefined;
export async function launch(): Promise<Browser> {
  if (browser) return browser;
  const executablePath = BROWSERS.find((p) => existsSync(p));
  if (!executablePath) throw new Error("no Edge or Chrome found; set BROWSER_PATH");
  browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1", "--hide-scrollbars"], defaultViewport: { width: 1600, height: 900 } });
  return browser;
}
export async function closeBrowser() { await browser?.close(); browser = undefined; }

const OVERLAY = `
(() => {
  const css = document.createElement('style');
  css.textContent = '#__cur{position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;left:-40px;top:-40px;transition:none}#__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}#__cur.down{transform:scale(.8)}#__cap{position:fixed;z-index:2147483646;left:0;right:0;bottom:0;padding:12px 28px;background:rgba(15,23,42,.92);color:#fff;font:600 20px Segoe UI,Helvetica,Arial,sans-serif;display:flex;gap:16px;align-items:baseline;pointer-events:none}#__cap small{font-weight:400;font-size:16px;color:#cbd5e1}#__cap b{color:#5eead4}';
  const init = () => {
    if (document.getElementById('__cur')) return;
    document.head.appendChild(css);
    const c = document.createElement('div'); c.id = '__cur'; c.setAttribute('style','position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;left:-40px;top:-40px');
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6 1.5L8 18z" fill="#fff" stroke="#111" stroke-width="1.4"/></svg>';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => c.classList.add('down'), true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();`;

export class Scene {
  caption = { title: "", sub: "" };
  private start = 0;
  private cdp?: CDPSession;
  private startSec = 0;
  private frames: { t: number; file: string }[] = [];
  private pending: Promise<unknown>[] = [];
  mouse = { x: 800, y: 450 };
  constructor(public id: string, public page: Page, public context: BrowserContext) {}

  async begin() {
    await this.page.evaluateOnNewDocument(OVERLAY);
    this.page.on("framenavigated", (frame) => { if (frame === this.page.mainFrame()) void this.paintCaption(); });
    this.page.on("load", () => void this.paintCaption());
    // Frames are saved with their own timestamps and stitched with exact durations: Puppeteer's built-in screencast
    // drops idle time, which would put the video out of step with the narration.
    mkdirSync(`${OUT}/frames-${this.id}`, { recursive: true });
    this.startSec = Date.now() / 1000;
    this.cdp = await this.page.createCDPSession();
    this.cdp.on("Page.screencastFrame", (ev) => {
      const file = `${OUT}/frames-${this.id}/${String(this.frames.length).padStart(6, "0")}.jpg`;
      this.frames.push({ t: Math.max(ev.metadata.timestamp ?? Date.now() / 1000, this.startSec), file }); // the first frame can carry an older paint time
      writeFileSync(file, Buffer.from(ev.data, "base64"));
      this.pending.push(this.cdp!.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => undefined));
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 1600, maxHeight: 900, everyNthFrame: 1 });
    this.start = Date.now();
  }
  async end(): Promise<number> {
    await sleep(800);
    const endedAt = Date.now() / 1000;
    await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
    await Promise.all(this.pending);
    const seconds = (Date.now() - this.start) / 1000;
    if (this.frames.length === 0) return seconds;
    // Bursts of frames closer than one output frame are collapsed to the latest one, so durations stay true.
    const t0 = this.frames[0]!.t;
    const kept: { t: number; file: string }[] = [];
    for (const f of this.frames) {
      const bucket = Math.floor((f.t - t0) * 30);
      if (kept.length && Math.floor((kept.at(-1)!.t - t0) * 30) === bucket) kept[kept.length - 1] = f; else kept.push(f);
    }
    const lines: string[] = [];
    kept.forEach((f, i) => {
      const next = kept[i + 1]?.t ?? Math.max(endedAt, f.t + 0.1);
      lines.push(`file '${process.cwd().replaceAll("\\", "/")}/${f.file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
    });
    lines.push(lines[lines.length - 2]!);
    writeFileSync(`${OUT}/${this.id}.txt`, lines.join("\n"));
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/${this.id}.txt`, "-vf", "fps=30,format=yuv420p", "-t", (endedAt - t0).toFixed(3), "-c:v", "libx264", "-crf", "20", "-preset", "fast", `${OUT}/${this.id}.mp4`], { stderr: "pipe" });
    await proc.exited;
    rmSync(`${OUT}/frames-${this.id}`, { recursive: true, force: true });
    return seconds;
  }

  async paintCaption() {
    const { title, sub } = this.caption;
    await this.page.evaluate(OVERLAY).catch(() => undefined); // also needed after setContent, which skips evaluateOnNewDocument
    await this.page.evaluate((t, s) => {
      let el = document.getElementById("__cap");
      if (!t) { el?.remove(); return; }
      if (!el) { el = document.createElement("div"); el.id = "__cap"; document.documentElement.appendChild(el); }
      el.setAttribute("style", "position:fixed;z-index:2147483646;left:0;right:0;bottom:0;padding:12px 28px;background:rgba(15,23,42,.92);color:#fff;font:600 20px Segoe UI,Helvetica,Arial,sans-serif;display:flex;gap:16px;align-items:baseline;pointer-events:none;text-align:left");
      el.innerHTML = `<b style="color:#5eead4">${t}</b><small style="font-weight:400;font-size:16px;color:#cbd5e1">${s}</small>`;
    }, title, sub).catch(() => undefined);
  }
  async setCaption(title: string, sub = "") { this.caption = { title, sub }; await this.paintCaption(); }

  // Holds the screen for as long as the line takes to say, while the action runs.
  async say(text: string, action?: () => Promise<unknown>) {
    const words = text.trim().split(/\s+/).length;
    const seconds = Math.max(2, words / WORDS_PER_SECOND);
    const at = (Date.now() - this.start) / 1000;
    timeline.push({ scene: this.id, at, say: text, seconds });
    const started = Date.now();
    await Promise.all([action ? action() : undefined, sleep(seconds * 1000)]);
    return (Date.now() - started) / 1000;
  }

  async goto(url: string, wait: "load" | "networkidle2" = "networkidle2") {
    await this.page.goto(url, { waitUntil: wait, timeout: 60000 });
  }
  async moveTo(x: number, y: number) {
    await this.page.mouse.move(x, y, { steps: 22 });
    this.mouse = { x, y };
  }
  async find(selector: string, timeout = 20000) {
    const handle = await this.page.waitForSelector(selector, { timeout, visible: true });
    if (!handle) throw new Error(`not found: ${selector}`);
    return handle;
  }
  async click(selector: string, opts: { pause?: number } = {}) {
    const el = await this.find(selector);
    await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await sleep(150);
    const box = await el.boundingBox();
    if (!box) throw new Error(`no box: ${selector}`);
    await this.moveTo(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(200);
    await this.page.mouse.down(); await sleep(70); await this.page.mouse.up();
    await sleep(opts.pause ?? 400);
  }
  async type(selector: string, text: string, delay = 55) {
    await this.click(selector, { pause: 120 });
    await this.page.keyboard.down("Control"); await this.page.keyboard.press("KeyA"); await this.page.keyboard.up("Control"); // replace anything a browser pre-filled
    await this.page.keyboard.type(text, { delay });
    await sleep(250);
  }
  async text(selector: string): Promise<string> {
    const el = await this.find(selector);
    return (await el.evaluate((n) => n.textContent ?? "")).trim();
  }

  // ---- terminal page ----
  async openTerminal(title = "terminal") {
    await this.page.setContent(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#0b1220}
#bar{height:34px;background:#1e293b;color:#94a3b8;font:14px Segoe UI,Arial;display:flex;align-items:center;padding:0 16px;gap:8px}
#bar i{width:12px;height:12px;border-radius:50%;display:inline-block}
#t{position:absolute;top:34px;bottom:56px;left:0;right:0;overflow:hidden;padding:14px 22px;color:#e2e8f0;font:17px/1.38 Cascadia Mono,Consolas,monospace;white-space:pre-wrap;word-break:break-all;box-sizing:border-box}
.p{color:#5eead4}.c{color:#fff}.d{color:#94a3b8}.ok{color:#86efac}.er{color:#fca5a5}</style>
<div id="bar"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#4ade80"></i><span id="ttl">${title}</span></div><div id="t"></div>`);
    await this.paintCaption();
  }
  private async append(html: string) {
    await this.page.evaluate((h) => { const t = document.getElementById("t")!; t.insertAdjacentHTML("beforeend", h); t.scrollTop = t.scrollHeight; }, html);
  }
  async clearTerminal() { await this.page.evaluate(() => { document.getElementById("t")!.innerHTML = ""; }); }
  async note(text: string) { await this.append(`<span class="d"># ${esc(text)}</span>\n`); await sleep(500); }

  // Types the command, runs it for real (on the VPS or here) and prints what came back.
  async run(command: string, opts: { where?: "remote" | "local"; shown?: string; maxLines?: number; env?: Record<string, string>; filter?: (out: string) => string } = {}): Promise<string> {
    const where = opts.where ?? "remote";
    const prompt = where === "remote" ? "ubuntu@urumi-vps:~/urumi$" : "you@laptop:~/urumi$";
    const shown = opts.shown ?? command;
    const pending = where === "remote" ? remote(command) : local(command, opts.env);
    await this.append(`<span class="p">${prompt} </span><span class="c" id="cur"></span>`);
    for (const ch of shown) {
      await this.page.evaluate((c) => { document.getElementById("cur")!.textContent += c; }, ch);
      await sleep(ch === " " ? 40 : 24);
    }
    await this.page.evaluate(() => { document.getElementById("cur")!.removeAttribute("id"); });
    await this.append("\n");
    await sleep(350);
    let out = (await pending).trimEnd();
    if (opts.filter) out = opts.filter(out);
    const lines = out.split("\n");
    const max = opts.maxLines ?? 400;
    const body = lines.length > max ? [...lines.slice(0, max), `… (${lines.length - max} more lines)`] : lines;
    // First screenful line by line so it reads like a terminal, the rest at once.
    const step = body.slice(0, 18);
    for (const line of step) { await this.append(colour(line) + "\n"); await sleep(55); }
    if (body.length > 18) await this.append(body.slice(18).map(colour).join("\n") + "\n");
    await this.append("\n");
    await sleep(500);
    return out;
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function colour(line: string) {
  const e = esc(line);
  if (/\b(BLOCKED|denied|Unreachable|unreachable|Failed|failed|rejected|error)\b/i.test(line) && !/NAME/.test(line)) return `<span class="er">${e}</span>`;
  if (/\b(Running|Ready|Connected|connected|Succeeded|deployed|OPEN|PASS)\b/.test(line)) return `<span class="ok">${e}</span>`;
  return e;
}

export async function scene(id: string, title: string, run: (s: Scene) => Promise<void>, { incognito = false } = {}): Promise<number> {
  const b = await launch();
  const context = incognito ? await b.createBrowserContext() : b.defaultBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  const s = new Scene(id, page, context);
  await s.begin();
  try {
    await run(s);
  } finally {
    const seconds = await s.end().catch(() => 0);
    await page.close().catch(() => undefined);
    if (incognito) await context.close().catch(() => undefined);
    console.log(`scene ${id} (${title}) recorded, ${seconds.toFixed(1)}s`);
    writeFileSync(`${OUT}/${id}.json`, JSON.stringify({ id, title, seconds, beats: timeline.filter((b) => b.scene === id) }, null, 1));
  }
  return 0;
}
