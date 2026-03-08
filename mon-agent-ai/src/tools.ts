import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// TOOL : CALCULATRICE
export const calculer = tool(
    async ({ expression }: { expression: string }) => {
        try {
            if (/[a-zA-Z]/.test(expression.replace(/Math\./g, ""))) {
                return "Erreur : Expression invalide (Lettres non autorisées)";
            }
            const resultat = Function(`"use strict"; return (${expression})`)();
            return `${expression} = ${resultat}`;
        } catch (e) {
            return `Erreur de calcul : ${(e as Error).message}`;
        }
    },
    {
        name: "calculer",
        description: "Evalue une expression mathématique. Exemple : '2 + 2', '10 * 5', '2 ** 10'",
        schema: z.object({
            expression: z.string().describe("Expression mathématique JavaScript valide"),
        }),
    }
);

// TOOL : LECTURE D'UN FICHIER
export const lireFichier = tool(
    async ({ chemin }: { chemin: string }) => {
        try {
            const cheminAbsolu = path.resolve(chemin);
            if (!fs.existsSync(cheminAbsolu)) {
                return `Fichier introuvable : ${cheminAbsolu}`;
            }
            const contenu = fs.readFileSync(cheminAbsolu, "utf-8");
            if (contenu.length > 3000) {
                return contenu.slice(0, 3000) + "\n...[fichier tronqué à 3000 caractères]";
            }
            return contenu;
        } catch (e) {
            return `Erreur lecture : ${(e as Error).message}`;
        }
    },
    {
        name: "lire_fichier",
        description: "Lit le contenu d'un fichier (.txt, .json, .ts, .md, etc.)",
        schema: z.object({
            chemin: z.string().describe("chemin du fichier , ex: './data/notes.txt'"),
        }),
    }
);

// TOOL : ECRITURE DANS UN FICHIER
export const ecrireFichier = tool(
    async ({ chemin, contenu, mode }) => {
        try {
            const cheminAbsolu = path.resolve(chemin);
            const dossier = path.dirname(cheminAbsolu);
            fs.mkdirSync(dossier, { recursive: true });

            if (mode === "append") {
                fs.appendFileSync(cheminAbsolu, contenu + "\n");
                return `Contenu ajouté à : ${cheminAbsolu}`;
            } else {
                fs.writeFileSync(cheminAbsolu, contenu, "utf-8");
                return `Fichier crée/écrasé dans : ${cheminAbsolu}`;
            }
        } catch (e) {
            return `Erreur écriture : ${(e as Error).message}`;
        }
    },
    {
        name: "ecrire_fichier",
        description: "Ecrit ou ajuste du contenu dans un fichier. Crée les dossiers manquants automatiquement.",
        schema: z.object({
            chemin: z.string().describe("Chemin du fichier à créer/modifier"),
            contenu: z.string().describe("Contenu à écrire"),
            mode: z.enum(["write", "append"]).optional().default("write")
                .describe("'write' = écrase, 'append' = ajoute à la fin"),
        }),
    }
);

// TOOL : LISTER LES FICHIERS D'UN DOSSIER
export const listerFichiers = tool(
    async ({ dossier }) => {
        try {
            const cheminAbsolu = path.resolve(dossier || ".");
            if (!fs.existsSync(cheminAbsolu)) {
                return `Dossier introuvable : ${cheminAbsolu}`;
            }
            const entrées = fs.readdirSync(cheminAbsolu, { withFileTypes: true });
            const liste = entrées.map((e) => {
                const type = e.isDirectory() ? "📁 Dossier" : "📄 Fichier";
                const stats = fs.statSync(path.join(cheminAbsolu, e.name));
                const taille = e.isFile() ? ` (${(stats.size / 1024).toFixed(1)} KB)` : "";
                return `${type} ${e.name}${taille}`;
            });
            return `📂 Contenu de ${cheminAbsolu} :\n${liste.join("\n")}`;
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "lister_fichiers",
        description: "Liste les fichiers et dossiers dans le répertoire.",
        schema: z.object({
            dossier: z.string().optional().default(".").describe("Chemin du dossier à lister (ex: './screenshots')"),
        }),
    }
);

// TOOL : OBTENIR LA DATE/HEURE ACTUELLE
export const obtenirDate = tool(
    async () => {
        const maintenant = new Date();
        return JSON.stringify({
            date: maintenant.toLocaleDateString("fr-FR"),
            heure: maintenant.toLocaleTimeString("fr-FR"),
            timestamp: maintenant.toISOString(),
            jourSemaine: maintenant.toLocaleDateString("fr-FR", { weekday: "long" }),
        });
    },
    {
        name: "obtenir_date",
        description: "Retourne la date et l'heure actuelles",
        schema: z.object({}),
    }
);

// export groupé
export const outilsDeBase = [calculer, lireFichier, ecrireFichier, listerFichiers, obtenirDate];