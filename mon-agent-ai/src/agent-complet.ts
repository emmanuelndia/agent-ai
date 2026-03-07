import { Sandbox } from '@e2b/code-interpreter';
import * as fs from 'fs';
import * as path from 'path';

export class E2BSandbox {
  private sandbox: Sandbox | null = null;
  private browserReady = false;  // true = browser + page initialisés dans le kernel Python
  private readonly screenshotsDir = path.resolve("./screenshots");
  private readonly SANDBOX_TIMEOUT = 5 * 60 * 1000; // 5 minutes (défaut E2B)
  private lastActivity = 0;

  constructor() {
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
  }

  // ─── Auto-recovery ────────────────────────────────────────────────────────
  // Vérifie si le sandbox et le navigateur sont encore vivants.
  // Si le sandbox a expiré (502) ou si `page` n'est pas défini → réinitialise.
  // Appelé avant chaque opération pour garantir un état valide.
  // ─────────────────────────────────────────────────────────────────────────

  private async assureSandboxVivant(): Promise<string | null> {
    // Vérifier si le sandbox est proche du timeout (4min30) ou déjà mort
    const now = Date.now();
    const sandboxExpired = this.lastActivity > 0 &&
      (now - this.lastActivity) > (this.SANDBOX_TIMEOUT - 30_000);

    if (!this.sandbox || !this.browserReady || sandboxExpired) {
      console.log("🔄 Sandbox E2B : réinitialisation automatique...");
      const result = await this.initialiser();
      if (result.startsWith("❌")) return result;
    } else {
      // Ping rapide pour vérifier que le kernel Python répond encore
      try {
        const ping = await this.sandbox!.runCode("print('ok')");
        if (ping.error || !ping.logs?.stdout?.join('').includes('ok')) {
          console.log("🔄 Sandbox E2B : kernel mort, réinitialisation...");
          const result = await this.initialiser();
          if (result.startsWith("❌")) return result;
        }
      } catch (e: any) {
        // 502 = sandbox timeout sur le remote
        if (e?.message?.includes("502") || e?.message?.includes("not found") ||
            e?.message?.includes("timeout") || e?.message?.includes("ECONNREFUSED")) {
          console.log("🔄 Sandbox E2B : 502 détecté, réinitialisation...");
          this.sandbox = null;
          this.browserReady = false;
          const result = await this.initialiser();
          if (result.startsWith("❌")) return result;
        } else {
          return `❌ Erreur sandbox : ${e?.message}`;
        }
      }
    }
    this.lastActivity = Date.now();
    return null; // OK
  }

  /**
   * Initialise la sandbox E2B et lance un navigateur Playwright.
   */
  async initialiser(options?: { headless?: boolean }): Promise<string> {
    try {
      // Fermer le sandbox existant proprement
      if (this.sandbox) {
        try { await this.sandbox.kill(); } catch {}
        this.sandbox = null;
        this.browserReady = false;
      }

      this.sandbox = await Sandbox.create({ timeoutMs: 5 * 60 * 1000 });

      const headless = options?.headless ?? true;

      const installCode = `
import subprocess
import sys

try:
    import playwright
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "playwright"])
    subprocess.check_call(["playwright", "install", "--with-deps", "chromium"])
print("Playwright installed or already present")
`;
      const installResult = await this.sandbox.runCode(installCode);
      if (installResult.error) {
        return `❌ Erreur installation Playwright : ${installResult.error.name}: ${installResult.error.value}`;
      }

      const setupCode = `
import asyncio
from playwright.async_api import async_playwright

async def setup_browser():
    global playwright, browser, page
    playwright = await async_playwright().start()
    browser = await playwright.chromium.launch(headless=${headless ? 'True' : 'False'})
    page = await browser.new_page()
    print("Browser ready")

await setup_browser()
`;
      const setupResult = await this.sandbox.runCode(setupCode);
      if (setupResult.error) {
        return `❌ Erreur setup navigateur : ${setupResult.error.name}: ${setupResult.error.value}\n${setupResult.error.traceback}`;
      }

      this.browserReady = true;
      this.lastActivity = Date.now();
      return "✅ Sandbox E2B et Navigateur Chromium prêts (Distant)";
    } catch (e) {
      return `❌ Erreur initialisation E2B : ${(e as Error).message}`;
    }
  }

  async allerVers(url: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      const code = `
import asyncio

async def go():
    await page.goto("${url}", wait_until="networkidle")
    print(f"Navigated to {page.url}")

await go()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur navigation : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Navigation : ${result.logs?.stdout?.join('\n') || result.text || ''}`;
    } catch (e) { return `❌ Erreur navigation : ${(e as Error).message}`; }
  }

  async lirePage(options: { format?: "texte" | "html" | "url" | "titre"; selecteur?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      let evalCode = '';
      if (options.format === "html") {
        evalCode = 'await page.content()';
      } else if (options.format === "url") {
        evalCode = 'page.url';
      } else if (options.format === "titre") {
        evalCode = 'await page.title()';
      } else {
        evalCode = options.selecteur
          ? `await page.inner_text("${options.selecteur}")`
          : 'await page.evaluate("() => document.body.innerText")';
      }

      const code = `
import asyncio

async def read():
    content = ${evalCode}
    print(content)

await read()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur lecture : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return (result.logs?.stdout?.join('\n') || result.text || '').slice(0, 5000);
    } catch (e) { return `❌ Erreur lecture : ${(e as Error).message}`; }
  }

  async cliquer(options: { selecteur?: string; texte?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      let action = '';
      if (options.texte) {
        action = `await page.get_by_text("${options.texte}").first.click()`;
      } else if (options.selecteur) {
        action = `await page.click("${options.selecteur}")`;
      } else {
        return "❌ Aucun sélecteur ou texte fourni";
      }

      const code = `
import asyncio

async def click():
    ${action}
    print("Clicked")

await click()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur clic : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Clic effectué sur ${options.texte || options.selecteur}`;
    } catch (e) { return `❌ Erreur clic : ${(e as Error).message}`; }
  }

  async taper(options: { selecteur: string; texte: string; effacer?: boolean }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      const effacer = options.effacer ?? true;
      const action = effacer
        ? `await page.fill("${options.selecteur}", "${options.texte.replace(/"/g, '\\"')}")`
        : `await page.type("${options.selecteur}", "${options.texte.replace(/"/g, '\\"')}")`;

      const code = `
import asyncio

async def type_text():
    ${action}
    print("Text typed")

await type_text()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur saisie : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Texte "${options.texte}" saisi dans ${options.selecteur}`;
    } catch (e) { return `❌ Erreur saisie : ${(e as Error).message}`; }
  }

  async screenshot(nom?: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      const code = `
import asyncio
import base64

async def take_screenshot():
    screenshot_bytes = await page.screenshot()
    print(base64.b64encode(screenshot_bytes).decode())

await take_screenshot()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur screenshot : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;

      const base64Data = result.logs?.stdout?.join('') || result.text;
      if (!base64Data) return "❌ Aucune donnée reçue pour le screenshot";
      this.lastActivity = Date.now();
      return `data:image/png;base64,${base64Data}`;
    } catch (e) { return `❌ Erreur screenshot : ${(e as Error).message}`; }
  }

  async attendre(options: { ms?: number; selecteur?: string; texte?: string }): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      let action = '';
      if (options.ms) {
        action = `await page.wait_for_timeout(${options.ms})`;
      } else if (options.selecteur) {
        action = `await page.wait_for_selector("${options.selecteur}")`;
      } else if (options.texte) {
        action = `await page.wait_for_selector("text=${options.texte}")`;
      } else {
        return "❌ Aucune condition d'attente spécifiée";
      }

      const code = `
import asyncio

async def wait():
    ${action}
    print("Wait complete")

await wait()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur attente : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Attente terminée`;
    } catch (e) { return `❌ Erreur attente : ${(e as Error).message}`; }
  }

  async cocherCase(selecteur: string): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      const code = `
import asyncio

async def check_box():
    await page.check("${selecteur}")
    print("Checkbox checked")

await check_box()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur cocher case : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Case cochée : ${selecteur}`;
    } catch (e) { return `❌ Erreur cocher case : ${(e as Error).message}`; }
  }

  async scroller(direction: "haut" | "bas", pixels: number = 400): Promise<string> {
    const err = await this.assureSandboxVivant();
    if (err) return err;

    try {
      const delta = direction === "bas" ? pixels : -pixels;
      const code = `
import asyncio

async def scroll():
    await page.evaluate("window.scrollBy(0, ${delta})")
    print("Scrolled")

await scroll()
`;
      const result = await this.sandbox!.runCode(code);
      if (result.error) return `❌ Erreur scroll : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      this.lastActivity = Date.now();
      return `✅ Scroll ${direction} de ${pixels} pixels effectué`;
    } catch (e) { return `❌ Erreur scroll : ${(e as Error).message}`; }
  }

  async fermer(): Promise<void> {
    if (this.sandbox) {
      try {
        await this.sandbox.runCode(`
import asyncio
async def close_browser():
    try: await browser.close()
    except: pass
    try: await playwright.stop()
    except: pass
await close_browser()
`);
      } catch {}
      try { await this.sandbox.kill(); } catch {}
      this.sandbox = null;
      this.browserReady = false;
    }
  }
}