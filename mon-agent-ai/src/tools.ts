import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const opt = <T extends z.ZodTypeAny>(s: T) => s.optional().nullable();

export const calculer = tool(
    async ({ expression }: { expression: string }) => {
        try {
            if (/[a-zA-Z]/.test(expression.replace(/Math\./g, ""))) {
                return "Erreur : Expression invalide (Lettres non autorisées)";
            }
            const resultat = Function(`"use strict"; return (${expression})`)();
            return `${expression} = ${resultat}`;
        } catch (e) { return `Erreur de calcul : ${(e as Error).message}`; }
    },
    {
        name: "calculer",
        description: "Evalue une expression mathématique. Exemple : '2 + 2', '10 * 5', '2 ** 10'",
        schema: z.object({ expression: z.string().describe("Expression mathématique JavaScript valide") }),
    }
);

export const lireFichier = tool(
    async ({ chemin }: { chemin: string }) => {
        try {
            const cheminAbsolu = path.resolve(chemin);
            if (!fs.existsSync(cheminAbsolu)) return `Fichier introuvable : ${cheminAbsolu}`;
            const contenu = fs.readFileSync(cheminAbsolu, "utf-8");
            return contenu.length > 3000 ? contenu.slice(0, 3000) + "\n...[tronqué]" : contenu;
        } catch (e) { return `Erreur lecture : ${(e as Error).message}`; }
    },
    {
        name: "lire_fichier",
        description: "Lit le contenu d'un fichier (.txt, .json, .ts, .md, etc.)",
        schema: z.object({ chemin: z.string().describe("chemin du fichier, ex: './data/notes.txt'") }),
    }
);

export const ecrireFichier = tool(
    async ({ chemin, contenu, mode }) => {
        try {
            const cheminAbsolu = path.resolve(chemin);
            fs.mkdirSync(path.dirname(cheminAbsolu), { recursive: true });
            if (mode === "append") {
                fs.appendFileSync(cheminAbsolu, contenu + "\n");
                return `Contenu ajouté à : ${cheminAbsolu}`;
            } else {
                fs.writeFileSync(cheminAbsolu, contenu, "utf-8");
                return `Fichier crée/écrasé : ${cheminAbsolu}`;
            }
        } catch (e) { return `Erreur écriture : ${(e as Error).message}`; }
    },
    {
        name: "ecrire_fichier",
        description: "Ecrit ou ajuste du contenu dans un fichier.",
        schema: z.object({
            chemin: z.string().describe("Chemin du fichier"),
            contenu: z.string().describe("Contenu à écrire"),
            mode: opt(z.enum(["write", "append"])).describe("'write' = écrase, 'append' = ajoute (défaut: write)"),
        }),
    }
);

export const listerFichiers = tool(
    async ({ dossier }) => {
        try {
            const cheminAbsolu = path.resolve(dossier ?? ".");
            if (!fs.existsSync(cheminAbsolu)) return `Dossier introuvable : ${cheminAbsolu}`;
            const entrées = fs.readdirSync(cheminAbsolu, { withFileTypes: true });
            return `📂 ${cheminAbsolu} :\n` + entrées.map(e => {
                const type = e.isDirectory() ? "📁" : "📄";
                const taille = e.isFile() ? ` (${(fs.statSync(path.join(cheminAbsolu, e.name)).size / 1024).toFixed(1)} KB)` : "";
                return `${type} ${e.name}${taille}`;
            }).join("\n");
        } catch (e) { return `❌ Erreur : ${(e as Error).message}`; }
    },
    {
        name: "lister_fichiers",
        description: "Liste les fichiers et dossiers dans le répertoire.",
        schema: z.object({
            dossier: opt(z.string()).describe("Chemin du dossier (défaut: répertoire courant)"),
        }),
    }
);

export const obtenirDate = tool(
    async () => {
        const n = new Date();
        return JSON.stringify({
            date: n.toLocaleDateString("fr-FR"),
            heure: n.toLocaleTimeString("fr-FR"),
            timestamp: n.toISOString(),
            jourSemaine: n.toLocaleDateString("fr-FR", { weekday: "long" }),
        });
    },
    {
        name: "obtenir_date",
        description: "Retourne la date et l'heure actuelles",
        schema: z.object({}),
    }
);

export const outilsDeBase = [calculer, lireFichier, ecrireFichier, listerFichiers, obtenirDate];