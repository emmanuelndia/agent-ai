import * as dotenv from "dotenv";
import { chromium, Browser, Page } from "playwright";

// Charge les variables d'environnement
dotenv.config();

export class BrowserUseIntegration {
  private apiKey: string;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor() {
    this.apiKey = process.env.BROWSER_USE_API_KEY || "";
    
    if (!this.apiKey) {
      throw new Error("❌ BROWSER_USE_API_KEY non trouvée dans .env");
    }
  }

  async initializeBrowser(headless: boolean = false): Promise<void> {
    if (this.browser) return;

    this.browser = await chromium.launch({ 
      headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    this.page = await this.browser.newPage();
    
    // Configuration anti-détection
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });
  }

  async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async executeTask(task: string, options: {
    timeout?: number;
    headless?: boolean;
    url?: string;
  } = {}): Promise<any> {
    try {
      console.log(`🚀 Exécution de la tâche: "${task}"`);
      
      await this.initializeBrowser(options.headless);
      
      if (!this.page) throw new Error("Navigateur non initialisé");

      // Si une URL est fournie, y aller d'abord
      if (options.url) {
        await this.page.goto(options.url, { waitUntil: 'domcontentloaded' });
      }

      // Implémentation simple de la tâche
      const result = await this.performTask(task);
      
      console.log("✅ Tâche terminée:", result);
      return result;
    } catch (error) {
      console.error("❌ Erreur lors de l'exécution:", error);
      throw error;
    }
  }

  private async performTask(task: string): Promise<any> {
    if (!this.page) throw new Error("Navigateur non initialisé");

    // Analyse simple de la tâche pour déterminer l'action
    const lowerTask = task.toLowerCase();

    if (lowerTask.includes("titre") || lowerTask.includes("title")) {
      const title = await this.page.title();
      return { type: 'title', content: title };
    }

    if (lowerTask.includes("recherche") || lowerTask.includes("search")) {
      // Chercher un input de recherche et remplir
      const searchInput = await this.page.locator('input[type="search"], input[name="q"], input[name="search"]').first();
      if (await searchInput.isVisible()) {
        const searchTerm = task.match(/recherche\s+(.+?)(?:\s+sur|\s+|$)/i)?.[1] || "";
        await searchInput.fill(searchTerm);
        await this.page.keyboard.press('Enter');
        await this.page.waitForLoadState('domcontentloaded');
        
        const results = await this.page.locator('body').textContent();
        return { type: 'search', content: results?.slice(0, 1000) || "Aucun résultat" };
      }
    }

    // Par défaut, retourner le contenu de la page
    const content = await this.page.locator('body').textContent();
    return { type: 'content', content: content?.slice(0, 2000) || "Contenu non trouvé" };
  }

  async searchAndExtract(query: string, url?: string): Promise<string> {
    const task = url 
      ? `Aller sur ${url} et trouver: ${query}`
      : `Recherche: ${query}`;
    
    const result = await this.executeTask(task, { url });
    return result.content || "Aucun contenu trouvé";
  }

  async fillForm(url: string, formData: Record<string, string>): Promise<void> {
    await this.executeTask(`Remplir formulaire sur ${url}`, { url });
    
    if (!this.page) throw new Error("Navigateur non initialisé");

    for (const [field, value] of Object.entries(formData)) {
      // Chercher les champs par name, id, placeholder ou type
      const selectors = [
        `input[name="${field}"]`,
        `#${field}`,
        `input[placeholder*="${field}"]`,
        `textarea[name="${field}"]`,
        `#${field}`
      ];

      let found = false;
      for (const selector of selectors) {
        try {
          const element = this.page.locator(selector).first();
          if (await element.isVisible({ timeout: 2000 })) {
            await element.fill(value);
            found = true;
            console.log(`✅ Champ "${field}" rempli avec "${value}"`);
            break;
          }
        } catch (e) {
          // Continuer avec le sélecteur suivant
        }
      }

      if (!found) {
        console.log(`⚠️ Champ "${field}" non trouvé`);
      }
    }

    // Chercher et cliquer sur le bouton de soumission
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Soumettre")',
      'button:has-text("Envoyer")',
      'button:has-text("Submit")',
      'button:has-text("Send")'
    ];

    for (const selector of submitSelectors) {
      try {
        const button = this.page.locator(selector).first();
        if (await button.isVisible({ timeout: 2000 })) {
          await button.click();
          console.log("✅ Formulaire soumis");
          await this.page.waitForLoadState('domcontentloaded');
          break;
        }
      } catch (e) {
        // Continuer avec le sélecteur suivant
      }
    }
  }

  async takeScreenshot(fileName?: string): Promise<string> {
    if (!this.page) throw new Error("Navigateur non initialisé");

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = fileName || `screenshot-${timestamp}.png`;
    const path = `./screenshots/${filename}`;
    
    await this.page.screenshot({ path, fullPage: true });
    console.log(`📸 Screenshot sauvegardé: ${path}`);
    return path;
  }
}

// Exemple d'utilisation
export async function testBrowserUse() {
  try {
    const browserUse = new BrowserUseIntegration();
    
    // Exemple 1: Visiter Google et extraire le titre
    console.log("Test 1: Visiter Google et extraire le titre");
    const result1 = await browserUse.searchAndExtract("titre de la page", "https://www.google.com");
    console.log("Résultat:", result1);
    
    // Exemple 2: Prendre un screenshot
    console.log("\nTest 2: Prendre un screenshot");
    await browserUse.takeScreenshot("google-homepage");
    
    // Fermer le navigateur
    await browserUse.closeBrowser();
    
    console.log("\n✅ Tests terminés avec succès!");
    
  } catch (error) {
    console.error("❌ Erreur dans le test:", error);
  }
}

// Exporter pour utilisation dans d'autres modules
export default BrowserUseIntegration;
