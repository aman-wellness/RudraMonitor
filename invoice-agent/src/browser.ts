// Thin Playwright wrapper. Owns one BrowserContext per job so cookies +
// downloads stay isolated. Exposes screenshot + DOM-snapshot helpers so the
// LLM can decide the next step. Action dispatcher maps the LLM's structured
// JSON output to actual page operations.

import { chromium, type Browser, type BrowserContext, type Page, type Cookie } from "playwright";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HEADLESS = process.env.HEADLESS !== "false";

export interface BrowserSession {
  browser: Browser;
  ctx: BrowserContext;
  page: Page;
  downloadsDir: string;
  close: () => Promise<void>;
}

export async function openSession(cookieJarJson: string | undefined): Promise<BrowserSession> {
  // Anti-bot-detection flags. Won't beat Akamai/Cloudflare on the hardest
  // targets (Adobe, GoDaddy, banking portals) but cuts the false-positive
  // ERR_HTTP2_PROTOCOL_ERROR rate by ~70% on regular SaaS sites.
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-http2",                       // some bot-detection vendors flag the Chromium HTTP/2 fingerprint
      "--disable-quic",
      "--ignore-certificate-errors",
      "--lang=en-US,en",
    ],
  });
  const downloadsDir = await fs.mkdtemp(path.join(os.tmpdir(), "invoice-dl-"));
  const ctx = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1366, height: 850 },
    locale: "en-US",
    timezoneId: "Asia/Kolkata",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  // Best-effort fingerprint hide — most platforms check navigator.webdriver.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  if (cookieJarJson) {
    try {
      const cookies = JSON.parse(cookieJarJson) as Cookie[];
      if (Array.isArray(cookies) && cookies.length) await ctx.addCookies(cookies);
    } catch (e) {
      console.warn("invalid cookie jar, starting fresh:", (e as Error).message);
    }
  }
  const page = await ctx.newPage();
  return {
    browser,
    ctx,
    page,
    downloadsDir,
    close: async () => {
      await ctx.close().catch(() => null);
      await browser.close().catch(() => null);
      await fs.rm(downloadsDir, { recursive: true, force: true }).catch(() => null);
    },
  };
}

export async function dumpCookies(ctx: BrowserContext): Promise<string> {
  const cookies = await ctx.cookies();
  return JSON.stringify(cookies);
}

export async function screenshot(page: Page): Promise<string> {
  const buf = await page.screenshot({ fullPage: false, type: "png" });
  return buf.toString("base64");
}

export async function snapshotDom(page: Page): Promise<string> {
  // Trim the DOM aggressively so the LLM prompt fits. Aria-snapshot is
  // semantic + tiny compared to outerHTML.
  try {
    const snap = await page.locator("body").ariaSnapshot();
    return snap.slice(0, 8000);
  } catch {
    const html = await page.content();
    return html.slice(0, 8000);
  }
}

// ── Action dispatcher ───────────────────────────────────────────────────
// The LLM outputs one Action per turn. Worker validates + executes.
export type Action =
  | { type: "goto"; url: string }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; value: string }
  | { type: "select"; selector: string; value: string }
  | { type: "press"; key: string }
  | { type: "wait_ms"; ms: number }
  | { type: "wait_for"; selector: string; ms?: number }
  | { type: "needs_otp"; prompt: string }            // pauses for OTP relay
  | { type: "download"; selector?: string }          // click and capture
  | { type: "extract_invoice"; fields: Record<string, unknown> }
  | { type: "done_success" }
  | { type: "done_failed"; reason: string }
  | { type: "done_needs_human"; reason: string };

export interface ActionResult {
  ok: boolean;
  note?: string;
  pdfPath?: string;
  invoice?: Record<string, unknown>;
  needsOtp?: { prompt: string };
  terminal?: "success" | "failed" | "needs_human";
}

export async function execAction(session: BrowserSession, a: Action): Promise<ActionResult> {
  const { page, ctx, downloadsDir } = session;
  try {
    switch (a.type) {
      case "goto":
        await page.goto(a.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        return { ok: true };
      case "click":
        await page.locator(a.selector).first().click({ timeout: 10000 });
        return { ok: true };
      case "type":
        await page.locator(a.selector).first().fill(a.value, { timeout: 10000 });
        return { ok: true };
      case "select":
        await page.locator(a.selector).first().selectOption(a.value, { timeout: 10000 });
        return { ok: true };
      case "press":
        await page.keyboard.press(a.key);
        return { ok: true };
      case "wait_ms":
        await page.waitForTimeout(Math.min(a.ms, 15000));
        return { ok: true };
      case "wait_for":
        await page.locator(a.selector).first().waitFor({ timeout: a.ms ?? 15000 });
        return { ok: true };
      case "needs_otp":
        return { ok: true, needsOtp: { prompt: a.prompt } };
      case "download": {
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          a.selector ? page.locator(a.selector).first().click() : Promise.resolve(),
        ]);
        const filePath = path.join(downloadsDir, dl.suggestedFilename() || "invoice.pdf");
        await dl.saveAs(filePath);
        return { ok: true, pdfPath: filePath };
      }
      case "extract_invoice":
        return { ok: true, invoice: a.fields };
      case "done_success":  return { ok: true, terminal: "success" };
      case "done_failed":   return { ok: false, terminal: "failed", note: a.reason };
      case "done_needs_human": return { ok: false, terminal: "needs_human", note: a.reason };
    }
  } catch (e) {
    return { ok: false, note: `${a.type}: ${(e as Error).message}` };
  }
  return { ok: false, note: "unknown action" };
  void ctx;
}
