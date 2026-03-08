import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { e2bSandbox } from "./e2b-sandbox";

export const demarrerSandbox = tool(
    async ({ headless }) => {
        try {
            const result = await e2bSandbox.initialiser({ headless: headless ?? undefined });
            return result;
        } catch (e) { return `Erreur : ${(e as Error).message}`; }
    },
    {
        name: "demarrer_sandbox",
        description: "Démarre une sandbox E2B sécurisée avec navigateur.",
        schema: z.object({
            headless: z.boolean().optional().default(false).describe("false = visible, true = invisible"),
        }),
    }
);

export const allerversE2B = tool(
    async ({ url }) => {
        try { return await e2bSandbox.allerVers(url); }
        catch (e) { return `Erreur navigation E2B : ${(e as Error).message}`; }
    },
    {
        name: "aller_vers_e2b",
        description: "Navigue vers une URL dans la sandbox E2B. Toujours inclure https://",
        schema: z.object({
            url: z.string().describe("URL complète, ex: 'https://www.google.com'"),
        }),
    }
);

export const cliquerE2B = tool(
    async ({ selecteur, texte }) => {
        try { return await e2bSandbox.cliquer({ selecteur: selecteur ?? undefined, texte: texte ?? undefined }); }
        catch (e) { return `Impossible de cliquer (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "cliquer_e2b",
        description: "Clique sur un élément dans la sandbox E2B. Préfère 'texte' pour les boutons.",
        schema: z.object({
            selecteur: z.string().optional().describe("Sélecteur CSS"),
            texte: z.string().optional().describe("Texte visible du bouton/lien"),
        }),
    }
);

export const taperE2B = tool(
    async ({ selecteur, texte, effacer }) => {
        try { return await e2bSandbox.taper({ selecteur, texte, effacer: effacer ?? true }); }
        catch (e) { return `Erreur de saisie (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "taper_e2b",
        description: "Tape du texte dans un champ de formulaire dans la sandbox E2B.",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS du champ"),
            texte: z.string().describe("Texte à taper"),
            effacer: z.boolean().optional().default(true).describe("Effacer avant de taper (défaut: true)"),
        }),
    }
);

export const lirePageE2B = tool(
    async ({ format, selecteur }) => {
        try { return await e2bSandbox.lirePage({ format: format ?? "texte", selecteur: selecteur ?? undefined }); }
        catch (e) { return `Erreur lecture (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "lire_page_e2b",
        description: "Lit le contenu de la page dans la sandbox E2B.",
        schema: z.object({
            format: z.enum(["texte", "html", "url", "titre"]).optional().default("texte").describe("Format (défaut: texte)"),
            selecteur: z.string().optional().describe("Sélecteur CSS spécifique"),
        }),
    }
);

export const screenshotE2B = tool(
    async ({ nom }) => {
        try { return await e2bSandbox.screenshot(nom ?? undefined); }
        catch (e) { return `Erreur screenshot (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "screenshot_e2b",
        description: "Prend une capture d'écran dans la sandbox E2B.",
        schema: z.object({
            nom: z.string().optional().describe("Nom du fichier sans extension"),
        }),
    }
);

export const attendreE2B = tool(
    async ({ ms, selecteur, texte }) => {
        try { return await e2bSandbox.attendre({ ms: ms ?? undefined, selecteur: selecteur ?? undefined, texte: texte ?? undefined }); }
        catch (e) { return `Timeout (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "attendre_e2b",
        description: "Attend dans la sandbox E2B (élément, texte ou temps).",
        schema: z.object({
            ms: z.number().optional().describe("Durée en millisecondes"),
            selecteur: z.string().optional().describe("Sélecteur CSS à attendre"),
            texte: z.string().optional().describe("Texte à attendre"),
        }),
    }
);

export const cocherCaseE2B = tool(
    async ({ selecteur }) => {
        try { return await e2bSandbox.cocherCase(selecteur); }
        catch (e) { return `Erreur (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "cocher_case_e2b",
        description: "Coche une case dans la sandbox E2B.",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS de la checkbox"),
        }),
    }
);

export const scrollerE2B = tool(
    async ({ direction, pixels }) => {
        try { return await e2bSandbox.scroller(direction ?? "bas", pixels ?? 400); }
        catch (e) { return `Erreur scroll (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "scroller_e2b",
        description: "Fait défiler la page dans la sandbox E2B.",
        schema: z.object({
            direction: z.enum(["haut", "bas"]).optional().default("bas").describe("Direction (défaut: bas)"),
            pixels: z.number().optional().default(400).describe("Pixels à défiler (défaut: 400)"),
        }),
    }
);

export const appuyerToucheE2B = tool(
    async ({ touche, selecteur }) => {
        try { return await e2bSandbox.appuyerTouche({ touche, selecteur: selecteur ?? undefined }); }
        catch (e) { return `Erreur touche (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "appuyer_touche_e2b",
        description: "Appuie sur une touche clavier dans la sandbox E2B. Exemples : 'Enter' pour valider un formulaire, 'Tab' pour naviguer entre champs, 'Escape' pour fermer. Peut cibler un élément précis avec un sélecteur CSS.",
        schema: z.object({
            touche: z.string().describe("Touche : 'Enter', 'Tab', 'Escape', 'ArrowDown', 'Space', etc."),
            selecteur: z.string().optional().describe("Sélecteur CSS optionnel de l'élément ciblé"),
        }),
    }
);

export const selectionnerOptionE2B = tool(
    async ({ selecteur, valeur, label }) => {
        try { return await e2bSandbox.selectionnerOption({ selecteur, valeur: valeur ?? undefined, label: label ?? undefined }); }
        catch (e) { return `Erreur sélection (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "selectionner_option_e2b",
        description: "Sélectionne une option dans un menu déroulant <select> dans la sandbox E2B. Utilise 'valeur' (attribut value) ou 'label' (texte visible).",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS du <select>"),
            valeur: z.string().optional().describe("Valeur de l'option (attribut value)"),
            label: z.string().optional().describe("Texte visible de l'option"),
        }),
    }
);

export const listerChampsFormulaire = tool(
  async () => {
    const script = `
      Array.from(document.querySelectorAll('input, select, textarea, button'))
          .map(el => ({
              tag: el.tagName,
              name: el.name,
              id: el.id,
              type: el.type,
              placeholder: el.placeholder,
              label: document.querySelector(\`label[for="\${el.id}"]\`)?.innerText || ''
          }))
    `;
    return await e2bSandbox.evaluerJS(script);
  },
  {
    name: "lister_champs_formulaire",
    description: "Liste tous les champs (input, select, textarea, button) de la page courante avec leurs attributs.",
    schema: z.object({}),
  }
);

export const evaluerJSE2B = tool(
    async ({ script }) => {
        try { return await e2bSandbox.evaluerJS(script); }
        catch (e) { return `Erreur JS (E2B) : ${(e as Error).message}`; }
    },
    {
        name: "evaluer_js_e2b",
        description: "Exécute du JavaScript directement sur la page dans la sandbox E2B. Utile pour lire des données dynamiques, forcer des valeurs de champs, ou interagir avec des éléments inaccessibles autrement.",
        schema: z.object({
            script: z.string().describe("Code JavaScript à exécuter sur la page (ex: 'document.title' ou 'document.querySelector(\"#email\").value')"),
        }),
    }
);

export const e2bTools = [
    demarrerSandbox,
    allerversE2B,
    cliquerE2B,
    taperE2B,
    lirePageE2B,
    screenshotE2B,
    attendreE2B,
    cocherCaseE2B,
    scrollerE2B,
    appuyerToucheE2B,
    selectionnerOptionE2B,
    listerChampsFormulaire,
    evaluerJSE2B,
];