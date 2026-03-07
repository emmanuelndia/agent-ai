import { Sandbox } from '@e2b/code-interpreter';
import * as fs from 'fs';
import * as path from 'path';

export class E2BSandbox {
  private sandbox: Sandbox | null = null;
  private browserReady = false;
  private lastActivity = 0;
  private readonly SANDBOX_TIMEOUT_MS = 4.5 * 60 * 1000; // 4min30 (expire à 5min)
  private readonly screenshotsDir = path.resolve("./screenshots");

  constructor() {
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
  }

  // ── Auto-recovery ──────────────────────────────────────────────────────────
  // Appelé avant chaque opération. Vérifie que le sandbox et le navigateur
  // sont vivants. Réinitialise automatiquement si :
  //   - sandbox jamais démarré
  //   - inactivité > 4min30 (expire à 5min chez E2B)
  //   - ping Python échoue (kernel mort)
  //   - erreur 502 (sandbox remote disparu)
  // ──────────────────────────────────────────────────────────────────────────
  private async assureSandboxVivant(): Promise<string | null> {
    const now = Date.now();
    const expired = this.lastActivity > 0 && (now - this.lastActivity) > this.SANDBOX_TIMEOUT_MS;

    if (!this.sandbox || !this.browserReady || expired) {
      console.log("🔄 E2B : réinitialisation automatique...");
      return await this._initialiser();
    }

    // Ping rapide pour vérifier que le kernel Python est encore vivant
    try {
      const ping = await this.sandbox!.runCode("print('ping')");
      const ok = ping.logs?.stdout?.join('').includes('ping');
      if (!ok || ping.error) {
        console.log("🔄 E2B : kernel mort, réinitialisation...");
        return await this._initialiser();
      }
    } catch (e: any) {
      if (e?.message?.includes("502") || e?.message?.includes("not found") ||
          e?.message?.includes("ECONNREFUSED") || e?.message?.includes("timeout")) {
        console.log("🔄 E2B : 502 détecté, réinitialisation...");
        this.sandbox = null;
        this.browserReady = false;
        return await this._initialiser();
      }
      return `❌ Erreur sandbox : ${e?.message}`;
    }

    this.lastActivity = Date.now();
    return null; // OK
  }

  private async _initialiser(headless = true): Promise<string | null> {
    // Fermer proprement si existant
    if (this.sandbox) {
      try { await this.sandbox.kill(); } catch {}
      this.sandbox = null;
      this.browserReady = false;
    }

    try {
      this.sandbox = await Sandbox.create({ timeoutMs: 5 * 60 * 1000 });

      const installResult = await this.sandbox.runCode(`
import subprocess, sys
try:
    import playwright
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
    subprocess.check_call(["playwright", "install", "--with-deps", "chromium"])
print("ready")
`);
      if (installResult.error) {
        return `❌ Playwright install : ${installResult.error.value}`;
      }

      const setupResult = await this.sandbox.runCode(`
import asyncio
from playwright.async_api import async_playwright

async def setup():
    global playwright, browser, page
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=${headless ? 'True' : 'False'})
    page = await browser.new_page()
    print("browser_ready")

await setup()
`);
      if (setupResult.error) {
        return `❌ Browser setup : ${setupResult.error.value}\n${setupResult.error.traceback}`;
      }

      this.browserReady = true;
      this.lastActivity = Date.now();
      return null; // succès
    } catch (e) {
      return `❌ Init E2B : ${(e as Error).message}`;
    }
  }

  async initialiser(options?: { headless?: boolean }): Promise<string> {
    const err = await this._initialiser(options?.headless ?? true);
    return err ?? "✅ Sandbox E2B et Navigateur Chromium prêts (Distant)";
  }

  async allerVers(url: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const result = await this.sandbox!.runCode(`
import asyncio
async def go():
    await page.goto("${url}", wait_until="networkidle")
    print(f"Navigated to {page.url}")
await go()
`);
      if (result.error) return `❌ Navigation : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Navigation : ${result.logs?.stdout?.join('\n') || ''}`;
    } catch (e) { return `❌ Navigation : ${(e as Error).message}`; }
  }

  async lirePage(options: { format?: "texte" | "html" | "url" | "titre"; selecteur?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      let evalCode = '';
      if (options.format === "html")        evalCode = 'await page.content()';
      else if (options.format === "url")    evalCode = 'page.url';
      else if (options.format === "titre")  evalCode = 'await page.title()';
      else evalCode = options.selecteur
        ? `await page.inner_text("${options.selecteur}")`
        : 'await page.evaluate("() => document.body.innerText")';

      const result = await this.sandbox!.runCode(`
import asyncio
async def read():
    content = ${evalCode}
    print(content)
await read()
`);
      if (result.error) return `❌ Lecture : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return (result.logs?.stdout?.join('\n') || '').slice(0, 5000);
    } catch (e) { return `❌ Lecture : ${(e as Error).message}`; }
  }

  async cliquer(options: { selecteur?: string; texte?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const action = options.texte
        ? `await page.get_by_text("${options.texte}").first.click()`
        : options.selecteur
          ? `await page.click("${options.selecteur}")`
          : null;
      if (!action) return "❌ Aucun sélecteur ou texte fourni";

      const result = await this.sandbox!.runCode(`
import asyncio
async def click():
    ${action}
    print("clicked")
await click()
`);
      if (result.error) return `❌ Clic : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Clic effectué sur ${options.texte || options.selecteur}`;
    } catch (e) { return `❌ Clic : ${(e as Error).message}`; }
  }

  async taper(options: { selecteur: string; texte: string; effacer?: boolean }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const texteEscaped = options.texte.replace(/"/g, '\\"');
      const action = (options.effacer ?? true)
        ? `await page.fill("${options.selecteur}", "${texteEscaped}")`
        : `await page.type("${options.selecteur}", "${texteEscaped}")`;

      const result = await this.sandbox!.runCode(`
import asyncio
async def type_text():
    ${action}
    print("typed")
await type_text()
`);
      if (result.error) return `❌ Saisie : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Texte "${options.texte}" saisi dans ${options.selecteur}`;
    } catch (e) { return `❌ Saisie : ${(e as Error).message}`; }
  }

  async screenshot(_nom?: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const result = await this.sandbox!.runCode(`
import asyncio, base64
async def shot():
    b = await page.screenshot()
    print(base64.b64encode(b).decode())
await shot()
`);
      if (result.error) return `❌ Screenshot : ${result.error.value}\n${result.error.traceback}`;
      const b64 = result.logs?.stdout?.join('') || result.text;
      if (!b64) return "❌ Screenshot : aucune donnée reçue";
      this.lastActivity = Date.now();
      return `data:image/png;base64,${b64}`;
    } catch (e) { return `❌ Screenshot : ${(e as Error).message}`; }
  }

  async attendre(options: { ms?: number; selecteur?: string; texte?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      let action = '';
      if (options.ms)              action = `await page.wait_for_timeout(${options.ms})`;
      else if (options.selecteur)  action = `await page.wait_for_selector("${options.selecteur}")`;
      else if (options.texte)      action = `await page.wait_for_selector("text=${options.texte}")`;
      else return "❌ Aucune condition d'attente spécifiée";

      const result = await this.sandbox!.runCode(`
import asyncio
async def wait():
    ${action}
    print("done")
await wait()
`);
      if (result.error) return `❌ Attente : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Attente terminée`;
    } catch (e) { return `❌ Attente : ${(e as Error).message}`; }
  }

  async cocherCase(selecteur: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const result = await this.sandbox!.runCode(`
import asyncio
async def check():
    await page.check("${selecteur}")
    print("checked")
await check()
`);
      if (result.error) return `❌ Cocher : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Case cochée : ${selecteur}`;
    } catch (e) { return `❌ Cocher : ${(e as Error).message}`; }
  }

  async scroller(direction: "haut" | "bas", pixels = 400): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;
    try {
      const delta = direction === "bas" ? pixels : -pixels;
      const result = await this.sandbox!.runCode(`
import asyncio
async def scroll():
    await page.evaluate("window.scrollBy(0, ${delta})")
    print("scrolled")
await scroll()
`);
      if (result.error) return `❌ Scroll : ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Scroll ${direction} de ${pixels}px`;
    } catch (e) { return `❌ Scroll : ${(e as Error).message}`; }
  }

  async fermer(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.runCode(`
import asyncio
async def close():
    try: await browser.close()
    except: pass
    try: await playwright.stop()
    except: pass
await close()
`);
      } catch {}
      try { await this.sandbox.kill(); } catch {}
      this.sandbox = null;
      this.browserReady = false;
    }
  }
}

export const e2bSandbox = new E2BSandbox();