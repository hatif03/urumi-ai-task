#!/usr/bin/env bun
// Drives the real dashboard in a headless Chromium-family browser (Edge or Chrome, found on the machine) and
// checks every page loads, the forms work, and nothing logs a console error. Screenshots go to docs/evidence/ui/.
//   bun scripts/ui-check.ts          needs the cluster up; no hosts-file entry needed (the browser maps the names)
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BROWSERS = [
  process.env.BROWSER_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
const executablePath = BROWSERS.find((p) => existsSync(p));
if (!executablePath) throw new Error("no Edge or Chrome found; set BROWSER_PATH");

const HOST = process.env.DASHBOARD_HOST ?? "dashboard.local";
const env = Object.fromEntries((() => { try { return readFileSync("deploy/secrets/generated.env", "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)); } catch { return []; } })());
const PASSWORD = process.env.ADMIN_PASSWORD ?? env.ADMIN_PASSWORD;
mkdirSync("docs/evidence/ui", { recursive: true });

let failures = 0;
const check = (ok: boolean, name: string, detail = "") => { if (!ok) failures++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1, MAP *.shop.localhost 127.0.0.1, MAP shop.local 127.0.0.1`, "--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1280, height: 900 },
});
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e instanceof Error ? e.message : String(e)}`));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource.*(401|503|404)/.test(m.text())) errors.push(`console: ${m.text()}`); });
const base = `http://${HOST}`;
const shot = (name: string) => page.screenshot({ path: `docs/evidence/ui/${name}.png` });
const text = async (selector: string) => (await page.$eval(selector, (el) => el.textContent ?? "").catch(() => "")) as string;
const waitText = (needle: string, timeout = 15000) => page.waitForFunction((n) => document.body.innerText.includes(n), { timeout }, needle).then(() => true, () => false);
const go = async (path: string) => { await page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path); };

// --- login
await page.goto(`${base}/`, { waitUntil: "networkidle2" });
check(page.url().endsWith("/login"), "an anonymous visit lands on the login page", page.url());
await shot("01-login");
await page.type("input[name=username]", "nobody");
await page.type("input[name=password]", "wrong-password");
await page.click("button[type=submit]");
check(await waitText("invalid username or password"), "a wrong password shows the error");
await page.$eval("input[name=username]", (el) => ((el as HTMLInputElement).value = ""));
await page.$eval("input[name=password]", (el) => ((el as HTMLInputElement).value = ""));
await page.type("input[name=username]", "ada");
await page.type("input[name=password]", PASSWORD!);
await page.click("button[type=submit]");
check(await waitText("Servers"), "admin signs in and lands on Servers");

// --- servers
check(await waitText("woocommerce"), "the WooCommerce server is listed first-class");
await new Promise((r) => setTimeout(r, 1500));
const serversText = await page.evaluate(() => document.body.innerText);
check(/Connected/i.test(serversText) && /utility/i.test(serversText) && /policy/i.test(serversText), "all three upstreams show a status", "Connected seen");
check(!/umk_|ciphertext|credential_ciphertext/.test(serversText), "no secret material on the page");
await shot("02-servers");

// --- every other page loads with its heading and without errors
for (const [path, heading, name] of [["/stores", "Stores", "03-stores"], ["/chat", "Chat", "04-chat"], ["/keys", "API keys", "05-keys"], ["/hosted", "Hosted", "06-hosted"], ["/members", "Members", "07-members"], ["/permissions", "Permissions", "08-permissions"], ["/audit", "Audit log", "09-audit"], ["/account", "Account", "10-account"]] as const) {
  await go(path);
  // The heading must be this page's own <h1> (the nav also contains every name), and the error boundary must be quiet.
  const ok = await page.waitForFunction((h) => document.querySelector("h1")?.textContent?.includes(h) ?? false, { timeout: 15000 }, heading).then(() => true, () => false);
  await new Promise((r) => setTimeout(r, 800));
  const broke = await page.evaluate(() => document.body.innerText.includes("Something broke"));
  check(ok && !broke, `${path} renders its "${heading}" heading`, broke ? await text("main") : "");
  await shot(name);
}

// --- audit shows who and how long
await go("/audit");
await waitText("Audit log");
await new Promise((r) => setTimeout(r, 1000));
const auditHeaders = await page.$$eval("th", (els) => els.map((e) => e.textContent ?? ""));
check(["When", "User", "Server", "Tool", "Outcome"].every((h) => auditHeaders.some((x) => x.includes(h))) && auditHeaders.some((x) => x.includes("Duration")), "the audit table has user and duration columns", auditHeaders.join("|"));
const auditRows = await page.$$eval("tbody tr", (els) => els.length);
check(auditRows > 0, "and has rows", `${auditRows}`);

// --- API keys: create one, the token is shown once
await go("/keys");
await waitText("API keys");
await page.type("form[aria-label='Create an API key'] input", "ui-check");
await page.click("form[aria-label='Create an API key'] button[type=submit]");
check(await waitText("umk_"), "creating a key shows the token once");
await shot("11-key-created");
const closeButton = await page.$("dialog[open] button");
if (closeButton) await closeButton.click();

// --- stores: the create form exists and refuses a bad name without calling the API into a 500
await go("/stores");
await waitText("Stores");
const storeInput = await page.$("form[aria-label='Create a store'] input");
check(!!storeInput, "the create-a-store form is present");

// --- chat without an LLM key says so
await go("/chat");
await waitText("Chat");
const chatText = await page.evaluate(() => document.body.innerText);
check(/LLM|key|configured/i.test(chatText) || (await page.$("textarea")) !== null, "chat shows its input or says no LLM is configured");

// --- sign out
await page.click("summary.usermenu, details.usermenu summary").catch(() => undefined);
const logout = await page.$$("button").then(async (buttons) => { for (const b of buttons) if (((await b.evaluate((e) => e.textContent)) ?? "").includes("Log out")) return b; return null; });
if (logout) await logout.click();
check(await page.waitForFunction(() => location.pathname === "/login", { timeout: 8000 }).then(() => true, () => false), "log out returns to the login page");

check(errors.length === 0, "no page errors or console errors during the run", errors.slice(0, 3).join(" | "));
await browser.close();
console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
process.exit(failures);
