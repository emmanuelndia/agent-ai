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

  async initialiser(): Promise<string> {
    try {
      // On crée une sandbox avec l'interpréteur de code
      this.sandbox = await Sandbox.create();
      
      // On prépare le navigateur Playwright à l'intérieur d'E2B (Python)
      const setupCode = `
import asyncio
from playwright.async_api import async_playwright

playwright = await async_playwright().start()
browser = await playwright.chromium.launch()
page = await browser.new_page()
print("Browser ready")
      `;
      await this.sandbox.notebook.execCell(setupCode);
      return "✅ Sandbox E2B et Navigateur Chromium prêts (Distant)";
    } catch (e) {
      return `❌ Erreur initialisation E2B : ${(e as Error).message}`;
    }
  }

  async allerVers(url: string): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";
    try {
      // On exécute du VRAI code de navigation
      const code = `await page.goto("${url}", wait_until="networkidle")\nprint(f"Navigated to {page.url}")`;
      const result = await this.sandbox.notebook.execCell(code);
      return `✅ Navigation : ${result.logs.stdout.join('\n')}`;
    } catch (e) {
      return `❌ Erreur navigation : ${(e as Error).message}`;
    }
  }

  async lirePage(options: { format?: "texte" | "html" }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";
    try {
      const code = options.format === "html" 
        ? `print(await page.content())` 
        : `print(await page.evaluate("() => document.body.innerText"))`;
      
      const result = await this.sandbox.notebook.execCell(code);
      return result.logs.stdout.join('\n').slice(0, 5000); // On limite pour pas exploser le contexte
    } catch (e) {
      return `❌ Erreur lecture : ${(e as Error).message}`;
    }
  }

  async cliquer(options: { selecteur?: string; texte?: string }): Promise<string> {
    if (!this.sandbox) return "❌ Sandbox non initialisée";
    const action = options.texte 
      ? `await page.get_by_text("${options.texte}").first.click()`
      : `await page.click("${options.selecteur}")`;
    
    try {
      await this.sandbox.notebook.execCell(action);
      return `✅ Clic effectué sur ${options.texte || options.selecteur}`;
    } catch (e) {
      return `❌ Erreur clic : ${(e as Error).message}`;
    }
  }

  async fermer(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.notebook.execCell(`await browser.close()\nawait playwright.stop()`);
      await this.sandbox.kill();
      this.sandbox = null;
    }
  }
}

export const e2bSandbox = new E2BSandbox();