import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { e2bSandbox } from "./e2b-sandbox";

// TOOL : DÉMARRER LA SANDBOX E2B
export const demarrerSandbox = tool(
    async ({ headless }) => {
        try {
            const result = await e2bSandbox.initialiser({ headless });
            return result;
        } catch (e) {
            return `Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "demarrer_sandbox",
        description: "Démarre une sandbox E2B sécurisée avec navigateur. Remplace le navigateur local.",
        schema: z.object({
            headless: z.boolean().optional()
                .describe("false = navigateur visible, true = navigateur invisible"),
        }),
    }
);

// TOOL : ALLER VERS UNE URL (E2B)
export const allerversE2B = tool(
    async ({ url }) => {
        try {
            return await e2bSandbox.allerVers(url);
        } catch (e) {
            return `Erreur navigation E2B : ${(e as Error).message}`;
        }
    },
    {
        name: "aller_vers_e2b",
        description: "Navigue vers une URL dans la sandbox E2B. Toujours inclure https://",
        schema: z.object({
            url: z.string().describe("URL complète, ex: 'https://www.google.com'"),
        }),
    }
);

// TOOL : CLIQUER (E2B)
export const cliquerE2B = tool(
    async ({ selecteur, texte }) => {
        try {
            return await e2bSandbox.cliquer({ selecteur, texte });
        } catch (e) {
            return `Impossible de cliquer (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "cliquer_e2b",
        description: 
            "Clique sur un élément dans la sandbox E2B. Préfère 'texte' pour les boutons.",
        schema: z.object({
            selecteur: z.string().optional().describe("Sélecteur CSS"),
            texte: z.string().optional().describe("Texte visible du bouton/lien"),
        }),
    }
);

// TOOL : TAPER (E2B)
export const taperE2B = tool(
    async ({ selecteur, texte, effacer }) => {
        try {
            return await e2bSandbox.taper({ selecteur, texte, effacer });
        } catch (e) {
            return `Erreur de saisie (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "taper_e2b",
        description: "Tape du texte dans un champ de formulaire dans la sandbox E2B.",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS du champ"),
            texte: z.string().describe("Texte à taper"),
            effacer: z.boolean().optional().default(true).describe("Effacer avant de taper"),
        }),
    }
);

// TOOL : LIRE PAGE (E2B)
export const lirePageE2B = tool(
    async ({ format, selecteur }) => {
        try {
            return await e2bSandbox.lirePage({ format, selecteur });
        } catch (e) {
            return `Erreur lecture (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "lire_page_e2b",
        description: "Lit le contenu de la page dans la sandbox E2B.",
        schema: z.object({
            format: z.enum(["texte", "html", "url", "titre"]).default("texte"),
            selecteur: z.string().optional().describe("Sélecteur CSS spécifique"),
        }),
    }
);

// TOOL : SCREENSHOT (E2B)
export const screenshotE2B = tool(
    async ({ nom }) => {
        try {
            return await e2bSandbox.screenshot(nom);
        } catch (e) {
            return `Erreur screenshot (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "screenshot_e2b",
        description: "Prend une capture d'écran dans la sandbox E2B.",
        schema: z.object({
            nom: z.string().optional().describe("Nom du fichier sans extension"),
        }),
    }
);

// TOOL : ATTENDRE (E2B)
export const attendreE2B = tool(
    async ({ ms, selecteur, texte }) => {
        try {
            return await e2bSandbox.attendre({ ms, selecteur, texte });
        } catch (e) {
            return `Timeout (E2B) : ${(e as Error).message}`;
        }
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

// TOOL : COCHER CASE (E2B)
export const cocherCaseE2B = tool(
    async ({ selecteur }) => {
        try {
            return await e2bSandbox.cocherCase(selecteur);
        } catch (e) {
            return `Erreur (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "cocher_case_e2b",
        description: "Coche une case dans la sandbox E2B.",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS de la checkbox"),
        }),
    }
);

// TOOL : SCROLLER (E2B)
export const scrollerE2B = tool(
    async ({ direction, pixels }) => {
        try {
            return await e2bSandbox.scroller(direction, pixels);
        } catch (e) {
            return `Erreur scroll (E2B) : ${(e as Error).message}`;
        }
    },
    {
        name: "scroller_e2b",
        description: "Fait défiler la page dans la sandbox E2B.",
        schema: z.object({
            direction: z.enum(["haut", "bas"]).default("bas"),
            pixels: z.number().optional().default(400),
        }),
    }
);

// Export tous les tools E2B
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
];
