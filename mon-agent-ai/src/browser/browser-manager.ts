import { Browser, BrowserContext, Page, chromium } from "playwright";

class GestionnaireNavigateur {
    private browser: Browser | null = null;
    private contexte: BrowserContext | null = null;
    private page: Page | null = null;
    private estInitialise = false;

    async initialiser(options: { headless?: boolean; slowMo?: number} = {}) {
        if (this.estInitialise) {
            console.log("Navigateur déjà initialisé");
            return this.page!;
        }

        console.log(" Démarrage du navigateur...");
        this.browser = await chromium.launch({
            headless: options.headless ?? false, // false = on voit le navigateur 
            slowMo: options.slowMo ?? 80,        // ralentit pour voir les actions
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled", // cache le fait qu'on est un bot
            ],
        });

        this.contexte = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            // Simuler un vrai utilisateur humain
            userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            locale: "fr-FR",
            timezoneId: "Europe/Paris",
        });

        // Script injecté dans chaque page pour masquer Playwright
        await this.contexte.addInitScript(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined});
        });

        this.page = await this.contexte.newPage();
        this.estInitialise = true;

        console.log(" Navigateur prêt !");
        return this.page;
    }

    getPage(): Page {
        if (!this.page || !this.estInitialise) {
            throw new Error(
                "Navigateur non initialisé. Appelle initialiser() d'abord ou demande à l'agent de démarrer le navigateur."
            );
        }
        return this.page;
    }

    async fermer() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.contexte = null;
            this.page = null;
            this.estInitialise = false;
            console.log("Navigateur fermé.");
        }
    }

    estActif(): boolean {
        return this.estInitialise;
    }
} 

// Singleton partagé dans tous le projet
export const navigateur = new GestionnaireNavigateur();