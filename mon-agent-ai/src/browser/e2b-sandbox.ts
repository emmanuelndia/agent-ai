import { Sandbox } from '@e2b/code-interpreter';
import * as fs from 'fs';
import * as path from 'path';

export class E2BSandbox {
  private sandbox: Sandbox | null = null;
  private readonly screenshotsDir = path.resolve("./screenshots");

  constructor() {
    if (!fs.existsSync(this.screenshotsDir)) {
      fs.mkdirSync(this.screenshotsDir, { recursive: true });
    }
  }

  /**
   * Initialise la sandbox E2B et lance un navigateur Playwright.
   * @param options.headless - Si true, le navigateur tourne en mode headless (invisible). Par défaut true.
   */
  async initialiser(options?: { headless?: boolean }): Promise<string> {
    try {
      // Création de la sandbox (utilise E2B_API_KEY de .env)
      this.sandbox = await Sandbox.create();

      const headless = options?.headless ?? false;

      // Étape 1: Installer Playwright si nécessaire (subprocess pour shell-like)
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
        return `❌ Erreur installation Playwright : ${installResult.error.name}: ${installResult.error.value}\n${installResult.error.traceback}`;
      }

      // Étape 2: Lancer le navigateur (wrapper async avec top-level await)
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

      return "✅ Sandbox E2B et Navigateur Chromium prêts (Distant)";
    } catch (e) {
      return `❌ Erreur initialisation E2B : ${(e as Error).message}`;
    }
  }

  /**
   * Navigue vers une URL dans la sandbox.
   */
  async allerVers(url: string): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      const code = `
import asyncio

async def go():
    await page.goto("${url}", wait_until="networkidle")
    print(f"Navigated to {page.url}")

await go()
`;
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur navigation : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      const output = result.logs?.stdout?.join('\n') || result.text || '';
      return `✅ Navigation : ${output}`;
    } catch (e) {
      return `❌ Erreur navigation : ${(e as Error).message}`;
    }
  }

  /**
   * Lit le contenu de la page (texte, HTML, URL ou titre).
   */
  async lirePage(options: { format?: "texte" | "html" | "url" | "titre"; selecteur?: string }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      let evalCode = '';
      if (options.format === "html") {
        evalCode = 'await page.content()';
      } else if (options.format === "url") {
        evalCode = 'page.url';
      } else if (options.format === "titre") {
        evalCode = 'await page.title()';
      } else {
        // Par défaut : texte de la page, ou d'un sélecteur spécifique si fourni
        if (options.selecteur) {
          evalCode = `await page.inner_text("${options.selecteur}")`;
        } else {
          evalCode = 'await page.evaluate("() => document.body.innerText")';
        }
      }

      const code = `
import asyncio

async def read():
    content = ${evalCode}
    print(content)

await read()
`;
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur lecture : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      const output = result.logs?.stdout?.join('\n') || result.text || '';
      return output.slice(0, 5000); // Limite pour le contexte
    } catch (e) {
      return `❌ Erreur lecture : ${(e as Error).message}`;
    }
  }

  /**
   * Clique sur un élément (par sélecteur CSS ou texte visible).
   */
  async cliquer(options: { selecteur?: string; texte?: string }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      let action = '';
      if (options.texte) {
        action = `await page.get_by_text("${options.texte}").first.click()`;
      } else if (options.selecteur) {
        action = `await page.click("${options.selecteur}")`;
      } else {
        return "❌ Aucun sélecteur ou texte fourni pour le clic";
      }

      const code = `
import asyncio

async def click():
    ${action}
    print("Clicked")

await click()
`;
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur clic : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      return `✅ Clic effectué sur ${options.texte || options.selecteur}`;
    } catch (e) {
      return `❌ Erreur clic : ${(e as Error).message}`;
    }
  }

  /**
   * Tape du texte dans un champ.
   */
  async taper(options: { selecteur: string; texte: string; effacer?: boolean }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

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
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur saisie : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      return `✅ Texte "${options.texte}" saisi dans ${options.selecteur}`;
    } catch (e) {
      return `❌ Erreur saisie : ${(e as Error).message}`;
    }
  }

  /**
   * Prend une capture d'écran et la sauvegarde localement.
   */
  async screenshot(nom?: string): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      const filename = nom ? `${nom}.png` : `screenshot_${Date.now()}.png`;
      const filepath = path.join(this.screenshotsDir, filename);

      const code = `
import asyncio
import base64

async def take_screenshot():
    screenshot_bytes = await page.screenshot()
    print(base64.b64encode(screenshot_bytes).decode())

await take_screenshot()
`;

      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur screenshot : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }

      const base64Data = result.logs?.stdout?.join('') || result.text;
      if (!base64Data) {
        return "❌ Aucune donnée reçue pour le screenshot";
      }

      const imageBuffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filepath, imageBuffer);

      return `✅ Screenshot sauvegardé : ${filepath}`;
    } catch (e) {
      return `❌ Erreur screenshot : ${(e as Error).message}`;
    }
  }

  /**
   * Attend un certain temps, ou l'apparition d'un élément/texte.
   */
  async attendre(options: { ms?: number; selecteur?: string; texte?: string }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

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
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur attente : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      return `✅ Attente terminée`;
    } catch (e) {
      return `❌ Erreur attente : ${(e as Error).message}`;
    }
  }

  /**
   * Coche une case.
   */
  async cocherCase(selecteur: string): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      const code = `
import asyncio

async def check_box():
    await page.check("${selecteur}")
    print("Checkbox checked")

await check_box()
`;
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur cocher case : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      return `✅ Case cochée : ${selecteur}`;
    } catch (e) {
      return `❌ Erreur cocher case : ${(e as Error).message}`;
    }
  }

  /**
   * Scrolle la page.
   */
  async scroller(direction: "haut" | "bas", pixels: number = 400): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";

    try {
      const delta = direction === "bas" ? pixels : -pixels;
      const code = `
import asyncio

async def scroll():
    await page.evaluate("window.scrollBy(0, ${delta})")
    print("Scrolled")

await scroll()
`;
      const result = await this.sandbox.runCode(code);
      if (result.error) {
        return `❌ Erreur scroll : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`;
      }
      return `✅ Scroll ${direction} de ${pixels} pixels effectué`;
    } catch (e) {
      return `❌ Erreur scroll : ${(e as Error).message}`;
    }
  }

  /**
   * Ferme la sandbox et libère les ressources.
   */
  async fermer(): Promise<void> {
    if (this.sandbox) {
      try {
        const closeCode = `
import asyncio

async def close_browser():
    try:
        await browser.close()
    except:
        pass
    try:
        await playwright.stop()
    except:
        pass
    print("Browser closed")

await close_browser()
`;
        const result = await this.sandbox.runCode(closeCode);
        if (result.error) {
          console.error(`Erreur fermeture navigateur : ${result.error.name}: ${result.error.value}\n${result.error.traceback}`);
        }
      } catch (e) {
        // Ignorer les erreurs de fermeture
      }
      await this.sandbox.kill();
      this.sandbox = null;
    }
  }
}

export const e2bSandbox = new E2BSandbox();