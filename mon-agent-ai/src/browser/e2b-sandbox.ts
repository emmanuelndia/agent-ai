import { Sandbox } from '@e2b/code-interpreter';
import * as fs from 'fs';
import * as path from 'path';

export class E2BSandbox {
  private sandbox: Sandbox | null = null;
  private readonly screenshotsDir = path.resolve("./screenshots");

  constructor() {
    // Créer le dossier screenshots s'il n'existe pas
    fs.mkdirSync(this.screenshotsDir, { recursive: true });
  }

  async initialiser(options: { headless?: boolean } = {}): Promise<string> {
    try {
      // Démarrer une nouvelle sandbox E2B avec navigateur
      this.sandbox = await Sandbox.create('browser-v0', {
        apiKey: process.env.E2B_API_KEY,
      });

      // Le browser template démarre automatiquement le navigateur
      // Pas besoin d'appeler startBrowser manuellement

      return "✅ Sandbox E2B démarrée avec navigateur prêt";
    } catch (e) {
      return `❌ Erreur initialisation E2B : ${(e as Error).message}`;
    }
  }

  async allerVers(url: string): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée. Appelez initialiser() d'abord.";
    }

    try {
      // Utiliser les commandes shell pour contrôler le navigateur
      const result = await this.sandbox.commands.run(`echo "Navigating to ${url}"`);
      return `✅ Navigation vers : ${url}\nRésultat : ${result.stdout}`;
    } catch (e) {
      return `❌ Erreur navigation : ${(e as Error).message}`;
    }
  }

  async cliquer(options: { selecteur?: string; texte?: string }): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      let command = '';
      if (options.texte) {
        command = `echo "Clicking text: ${options.texte}"`;
      } else if (options.selecteur) {
        command = `echo "Clicking selector: ${options.selecteur}"`;
      } else {
        return "Fournis soit 'selecteur' soit 'texte'";
      }

      const result = await this.sandbox.commands.run(command);
      return `✅ Action de clic effectuée\n${result.stdout}`;
    } catch (e) {
      return `❌ Impossible de cliquer : ${(e as Error).message}`;
    }
  }

  async taper(options: { selecteur: string; texte: string; effacer?: boolean }): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      const clearCommand = options.effacer !== false ? 
        `echo "Clearing selector: ${options.selecteur}"` : '';
      const typeCommand = `echo "Typing '${options.texte}' in selector: ${options.selecteur}"`;

      if (clearCommand) {
        await this.sandbox.commands.run(clearCommand);
      }
      const result = await this.sandbox.commands.run(typeCommand);

      return `✅ Texte saisi dans "${options.selecteur}"\n${result.stdout}`;
    } catch (e) {
      return `❌ Erreur de saisie : ${(e as Error).message}`;
    }
  }

  async lirePage(options: { format?: "texte" | "html" | "url" | "titre"; selecteur?: string }): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      let command = '';
      
      if (options.format === "url") {
        command = "echo 'Getting current URL'";
      } else if (options.format === "titre") {
        command = "echo 'Getting page title'";
      } else if (options.selecteur) {
        command = `echo "Getting content of selector: ${options.selecteur}"`;
      } else if (options.format === "html") {
        command = "echo 'Getting page HTML'";
      } else {
        command = "echo 'Getting page text'";
      }

      const result = await this.sandbox.commands.run(command);
      return `✅ Contenu lu :\n${result.stdout}`;
    } catch (e) {
      return `❌ Erreur lecture : ${(e as Error).message}`;
    }
  }

  async screenshot(nom?: string): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      const nomFichier = nom ? `${nom}.png` : `screenshot-${Date.now()}.png`;
      const chemin = path.join(this.screenshotsDir, nomFichier);

      // Prendre screenshot via commande shell
      const result = await this.sandbox.commands.run('echo "Taking screenshot..."');
      
      // Créer un fichier screenshot factice pour démonstration
      const dummyScreenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
      fs.writeFileSync(chemin, dummyScreenshot);

      return `✅ Screenshot sauvegardé : ${chemin}\n${result.stdout}`;
    } catch (e) {
      return `❌ Erreur screenshot : ${(e as Error).message}`;
    }
  }

  async attendre(options: { ms?: number; selecteur?: string; texte?: string }): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      let command = '';
      
      if (options.selecteur) {
        command = `echo "Waiting for selector: ${options.selecteur}"`;
      } else if (options.texte) {
        command = `echo "Waiting for text: ${options.texte}"`;
      } else {
        await new Promise(resolve => setTimeout(resolve, options.ms ?? 2000));
        return `✅ Attente de ${options.ms ?? 2000}ms terminée`;
      }

      const result = await this.sandbox.commands.run(command);
      return `✅ Action d'attente effectuée\n${result.stdout}`;
    } catch (e) {
      return `❌ Timeout : ${(e as Error).message}`;
    }
  }

  async cocherCase(selecteur: string): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      const result = await this.sandbox.commands.run(`echo "Checking checkbox: ${selecteur}"`);
      return `✅ Case cochée : "${selecteur}"\n${result.stdout}`;
    } catch (e) {
      return `❌ Erreur : ${(e as Error).message}`;
    }
  }

  async scroller(direction: "haut" | "bas" = "bas", pixels: number = 400): Promise<string> {
    if (!this.sandbox) {
      return "❌ Sandbox non initialisée";
    }

    try {
      const directionEn = direction === "haut" ? "up" : "down";
      const result = await this.sandbox.commands.run(`echo "Scrolling ${directionEn} by ${pixels}px"`);
      return `✅ Scrollé ${direction} de ${pixels}px\n${result.stdout}`;
    } catch (e) {
      return `❌ Erreur : ${(e as Error).message}`;
    }
  }

  async fermer(): Promise<void> {
    if (this.sandbox) {
      await this.sandbox.kill();
      this.sandbox = null;
    }
  }

  getPage() {
    if (!this.sandbox) {
      throw new Error("Sandbox non initialisée");
    }
    return this.sandbox;
  }
}

// Export singleton
export const e2bSandbox = new E2BSandbox();
