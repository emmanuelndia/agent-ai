import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { navigateur } from "./browser-manager";
import * as fs from "fs";
import * as path from "path";

// TOOL : DEMARRER LE NAVIGATEUR
export const demarrerNavigateur = tool(
    async ({ headless }) => {
        try {
            await navigateur.initialiser({ headless: headless ?? false});
            return "Navigateur démarré et prêt.";
        } catch (e) {
            return `Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "demarrer_navigateur",
        description: "Démarrer le navigateur Chrome. A appeler avant toute autre fonction de navigation.",
        schema: z.object({
            headless: z.boolean().optional()
                .describe("false = navigateur visible (recommandé), true = navigateur invisible"),
        }),
    }
);

// TOOL : ALLER VERS UNE URL
export const allervers = tool(
    async ({ url }) => {
        try {
            const page = navigateur.getPage();
            await page.goto(url, {waitUntil: "domcontentloaded", timeout: 30000});
            const titre = await page.title();
            return `Page chargée : "${titre}"\nURL : ${page.url()}`;
        } catch (e) {
            return `Erreur navigation : ${(e as Error).message}`;
        }
    },
    {
        name: "aller_vers",
        description: "Navigue vers une URL. Toujours inclure https://",
        schema: z.object({
            url: z.string().describe("URL complète, ex: 'https://www.google.com'"),
        }),
    }
);

// TOOL : CLIQUER SUR UN ELEMENT
export const cliquer = tool(
    async ({ selecteur, texte }) => {
        try {
            const page = navigateur.getPage();

            if (texte) {
                // Chercher par texte visible (plus robuste)
                await page.getByText(texte, {exact: false}).first().click({ timeout: 10000});
                return `Clic sur l'élément avec le texte : "${texte}"`;
            }

            if (selecteur) {
                await page.click(selecteur, { timeout: 10000});
                return `Clic sur : "${selecteur}"`;
            }

            return "Fournis soit 'sélecteur' soit 'texte'";
        } catch (e) {
            return `Impossible de cliquer : ${(e as Error).message}`;
        }
    },
    {
        name: "cliquer",
        description: 
            "Clique sur un élément. Préfère 'texte' pour les boutons (ex: texte='Créer un compte'). Utilise 'selecteur' CSS pour les éléments sans texte.",
        schema: z.object({
            selecteur: z.string().optional().describe("Sélecteur CSS, ex: '#submit-btn', 'input[type='submit']'"),
            texte: z.string().optional().describe("Texte visible du bouton/lien, ex: 'Connexion', 'Sign Up"),
        }),
    }
);

// TOOL : TAPER DU TEXTE
export const taper = tool(
  async ({ selecteur, texte, effacer }) => {
    try {
      const page = navigateur.getPage();
      
      // Attendre que la page soit stable
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
      
      const élément = page.locator(selecteur).first();
      await élément.waitFor({ state: 'visible', timeout: 10000 });

      if (effacer !== false) {
        await élément.clear();
      }

      // Tape lentement pour imiter un humain
      await élément.pressSequentially(texte, { delay: 60 });
      return `✅ Texte saisi dans "${selecteur}"`;
    } catch (e) {
      return `❌ Erreur de saisie dans "${selecteur}" : ${(e as Error).message}`;
    }
  },
  {
    name: "taper",
    description:
      "Tape du texte dans un champ de formulaire. Sélecteurs courants : 'input[name=q]' (Google), 'input[name=email]', '#password', 'textarea', 'input[type=text]'",
    schema: z.object({
      selecteur: z.string().describe("Sélecteur CSS du champ de saisie"),
      texte: z.string().describe("Texte à taper"),
      effacer: z.boolean().optional().default(true).describe("Effacer le contenu avant de taper"),
    }),
  }
);

// TOOL : APPUYER SUR UNE TOUCHE
export const appuyerTouche = tool(
  async ({ touche }) => {
    try {
      const page = navigateur.getPage();
      
      // Attendre un peu que la page soit stable
      await page.waitForTimeout(500);
      
      await page.keyboard.press(touche);
      
      // Attendre que la navigation potentielle se termine
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
      } catch (e) {
        // Ignore les timeouts de navigation
      }
      
      return `✅ Touche "${touche}" pressée`;
    } catch (e) {
      return `❌ Erreur appui touche "${touche}" : ${(e as Error).message}`;
    }
  },
  {
    name: "appuyer_touche",
    description: "Appuie sur une touche clavier. Utile pour 'Enter' après un formulaire.",
    schema: z.object({
      touche: z.string().describe("Nom de la touche : 'Enter', 'Tab', 'Escape', 'ArrowDown'..."),
    }),
  }
);


// TOOL : LIRE LE CONTENU DE LA PAGE
export const lirePage = tool(
  async ({ format, selecteur }) => {
    try {
      const page = navigateur.getPage();

      if (format === "url") return `URL actuelle : ${page.url()}`;
      if (format === "titre") return `Titre : ${await page.title()}`;

      if (selecteur) {
        const texte = await page.locator(selecteur).first().textContent({ timeout: 5000 });
        return `Contenu de "${selecteur}" : ${texte || "(vide)"}`;
      }

      if (format === "html") {
        // Extrait l'HTML de la partie principale (sans head/scripts)
        const html = await page.evaluate(() => document.body.innerHTML);
        return html.slice(0, 4000) + (html.length > 4000 ? "\n... [HTML tronqué]" : "");
      }

      // Texte visible par défaut
      const texte = await page.evaluate(() => document.body.innerText);
      return texte.slice(0, 3000) + (texte.length > 3000 ? "\n... [texte tronqué]" : "");
    } catch (e) {
      return `❌ Erreur de lecture : ${(e as Error).message}`;
    }
  },
  {
    name: "lire_page",
    description:
      "Lit le contenu de la page. Utilise format='html' pour voir les sélecteurs CSS, format='texte' pour lire le contenu, format='url' pour l'URL actuelle.",
    schema: z.object({
      format: z.enum(["texte", "html", "url", "titre"]).default("texte"),
      selecteur: z.string().optional().describe("Sélecteur CSS d'un élément spécifique"),
    }),
  }
);


// TOOL : SCREENSHOT
export const screenshot = tool(
  async ({ nom }) => {
    try {
      const page = navigateur.getPage();
      const dossier = path.resolve("./screenshots");
      fs.mkdirSync(dossier, { recursive: true });

      const nomFichier = nom ? `${nom}.png` : `screenshot-${Date.now()}.png`;
      const chemin = path.join(dossier, nomFichier);

      await page.screenshot({ path: chemin, fullPage: true });
      return `✅ Screenshot sauvegardé : ${chemin}`;
    } catch (e) {
      return `❌ Erreur screenshot : ${(e as Error).message}`;
    }
  },
  {
    name: "screenshot",
    description: "Prend une capture d'écran de la page actuelle. Utile pour vérifier l'état.",
    schema: z.object({
      nom: z.string().optional().describe("Nom du fichier sans extension (optionnel)"),
    }),
  }
);


// TOOL : ATTENDRE
export const attendre = tool(
  async ({ ms, sélecteur, texte }) => {
    try {
      const page = navigateur.getPage();

      if (sélecteur) {
        await page.waitForSelector(sélecteur, { timeout: 15000 });
        return `✅ Élément "${sélecteur}" trouvé`;
      }

      if (texte) {
        await page.waitForFunction(
          (t: string) => document.body.innerText.includes(t),
          texte,
          { timeout: 15000 }
        );
        return `✅ Texte "${texte}" trouvé sur la page`;
      }

      await page.waitForTimeout(ms ?? 2000);
      return `✅ Attente de ${ms ?? 2000}ms terminée`;
    } catch (e) {
      return `❌ Timeout : ${(e as Error).message}`;
    }
  },
  {
    name: "attendre",
    description:
      "Attend qu'un élément apparaisse, qu'un texte soit présent, ou attend simplement X millisecondes.",
    schema: z.object({
      ms: z.number().optional().describe("Durée en millisecondes"),
      sélecteur: z.string().optional().describe("Sélecteur CSS à attendre"),
      texte: z.string().optional().describe("Texte à attendre sur la page"),
    }),
  }
);

// TOOL : REMPLIR UN FORMULAIRE
export const remplir_formulaire = tool(
  async ({ donnees_formulaire }) => {
    try {
      const page = navigateur.getPage();
      // On s'attend à recevoir une chaîne JSON ou un format simple
      const champs = typeof donnees_formulaire === 'string' 
        ? JSON.parse(donnees_formulaire) 
        : donnees_formulaire;

      for (const [selector, value] of Object.entries(champs)) {
        await page.waitForSelector(selector, { state: 'visible', timeout: 5000 });
        await page.fill(selector, value as string);
      }
      return "Formulaire rempli avec succès.";
    } catch (e) {
      return `Erreur : ${(e as Error).message}`;
    }
  },
  {
    name: "remplir_formulaire",
    description: "Remplit plusieurs champs. Format attendu: un objet JSON simple {'sélecteur': 'valeur'}.",
    schema: z.object({
      // On évite z.record() qui génère "propertyNames"
      donnees_formulaire: z.string().describe("Objet JSON des champs à remplir (ex: '{\"#email\": \"test@test.com\"}')")
    }),
  }
);


// TOOL : COCHER UNE CASE 
export const cocherCase = tool(
  async ({ sélecteur }) => {
    try {
      const page = navigateur.getPage();
      await page.check(sélecteur, { timeout: 5000 });
      return `✅ Case cochée : "${sélecteur}"`;
    } catch (e) {
      return `❌ Erreur : ${(e as Error).message}`;
    }
  },
  {
    name: "cocher_case",
    description: "Coche une case à cocher (checkbox). Utile pour accepter les CGU.",
    schema: z.object({
      sélecteur: z.string().describe("Sélecteur CSS de la checkbox"),
    }),
  }
);


// TOOL : SCROLLER
export const scroller = tool(
  async ({ direction, pixels }) => {
    try {
      const page = navigateur.getPage();
      const y = direction === "haut" ? -(pixels ?? 400) : (pixels ?? 400);
      await page.evaluate((yVal: number) => window.scrollBy(0, yVal), y);
      return `✅ Scrollé ${direction} de ${pixels ?? 400}px`;
    } catch (e) {
      return `❌ Erreur : ${(e as Error).message}`;
    }
  },
  {
    name: "scroller",
    description: "Fait défiler la page vers le haut ou le bas.",
    schema: z.object({
      direction: z.enum(["haut", "bas"]).default("bas"),
      pixels: z.number().optional().default(400),
    }),
  }
);

export const browserTools = [
    demarrerNavigateur,
    allervers,
    cliquer,
    taper,
    appuyerTouche,
    lirePage,
    remplir_formulaire,
    screenshot,
    attendre,
    cocherCase,
    scroller,
];