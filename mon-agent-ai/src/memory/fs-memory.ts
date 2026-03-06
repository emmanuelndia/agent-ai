import * as fs   from "fs";
import * as path from "path";
import { tool }  from "@langchain/core/tools";
import { z }     from "zod";

// CONFIGURATION

export const MEMORY_DIR      = path.resolve("./agent-memory");
export const RESULTS_DIR     = path.join(MEMORY_DIR, "tool-results");
export const PLANS_DIR       = path.join(MEMORY_DIR, "plans");
export const DISCOVERIES_DIR = path.join(MEMORY_DIR, "discoveries");
export const INSTRUCTIONS_FILE = path.join(MEMORY_DIR, "instructions.md");
export const SESSION_FILE    = path.join(MEMORY_DIR, "session.json");

/** Seuil en caractères au-delà duquel un résultat est déchargé sur disque */
export const OFFLOAD_THRESHOLD = 800;

/** Initialise la structure de dossiers au démarrage */
export function initMemoryDirs(): void {
    [MEMORY_DIR, RESULTS_DIR, PLANS_DIR, DISCOVERIES_DIR].forEach(dir =>
        fs.mkdirSync(dir, { recursive: true })
    );
    if (!fs.existsSync(INSTRUCTIONS_FILE)) {
        fs.writeFileSync(
            INSTRUCTIONS_FILE,
            "# Instructions apprises par l'agent\n\n" +
            "Ce fichier est mis à jour automatiquement lorsque l'utilisateur donne des conseils.\n\n",
            "utf-8"
        );
    }
    if (!fs.existsSync(SESSION_FILE)) {
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ demarree: new Date().toISOString(), fichiers: [] }, null, 2));
    }
}

// Appel immédiat à l'import
initMemoryDirs();

// MIDDLEWARE D'OFFLOAD AUTOMATIQUE

/**
 * Intercepte le résultat d'un outil. Si sa taille dépasse OFFLOAD_THRESHOLD,
 * il est sauvegardé dans un fichier et remplacé par un message court
 * indiquant au LLM où chercher et comment utiliser grep_memoire.
 *
 * C'est ici que se réalise l'économie de tokens.
 */
export function offloadSiVolumineux(
    toolName: string,
    result: string
): string {
    if (result.length <= OFFLOAD_THRESHOLD) {
        return result; // Résultat léger → reste dans le contexte
    }

    const timestamp = Date.now();
    const nomFichier = `${timestamp}-${toolName.replace(/_/g, "-")}.txt`;
    const cheminFichier = path.join(RESULTS_DIR, nomFichier);

    fs.writeFileSync(cheminFichier, result, "utf-8");
    enregistrerFichierSession(cheminFichier);

    const tailleKo = (result.length / 1024).toFixed(1);

    return (
        `📁 Résultat volumineux (${tailleKo} Ko, ${result.length} caractères) sauvegardé dans :\n` +
        `   ${cheminFichier}\n\n` +
        `Pour exploiter ce résultat, utilise les outils FS-Memory :\n` +
        `• grep_memoire    → chercher un mot/pattern dans ce fichier\n` +
        `• lire_lignes     → lire des lignes précises (ex: lignes 10 à 30)\n` +
        `• rechercher_glob → trouver d'autres fichiers du même type\n\n` +
        `Exemple : grep_memoire({ fichier: "${cheminFichier}", pattern: "email" })\n` +
        `Aperçu des 300 premiers caractères :\n` +
        `─────────────────────────────────\n` +
        result.slice(0, 300) + "\n[…]"
    );
}

function enregistrerFichierSession(chemin: string): void {
    try {
        const session = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
        session.fichiers = session.fichiers || [];
        session.fichiers.push({ chemin, createdAt: new Date().toISOString() });
        fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    } catch { /* silencieux */ }
}

// OUTILS FS-MEMORY EXPOSÉS AU LLM

/**
 * GREP — Cherche un pattern (texte ou regex) dans un fichier.
 * Retourne les lignes correspondantes avec leur numéro.
 * Équivalent de `grep -n pattern fichier`
 */
export const grepMemoire = tool(
    async ({ fichier, pattern, maxLignes, ignoreCase }) => {
        try {
            const chemin = path.resolve(fichier);
            if (!fs.existsSync(chemin)) return `❌ Fichier introuvable : ${chemin}`;

            const contenu = fs.readFileSync(chemin, "utf-8");
            const lignes  = contenu.split("\n");
            const flags   = ignoreCase ? "gi" : "g";

            let regex: RegExp;
            try {
                regex = new RegExp(pattern, flags);
            } catch {
                // Fallback : recherche littérale si le pattern n'est pas une regex valide
                regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
            }

            const resultats = lignes
                .map((ligne, i) => ({ ligne, num: i + 1 }))
                .filter(({ ligne }) => regex.test(ligne))
                .slice(0, maxLignes ?? 30);

            if (resultats.length === 0) {
                return `🔍 Aucune occurrence de "${pattern}" trouvée dans ${path.basename(chemin)}.`;
            }

            const sortie = resultats
                .map(({ num, ligne }) => `L${String(num).padStart(4, "0")} │ ${ligne}`)
                .join("\n");

            return (
                `🔍 ${resultats.length} occurrence(s) de "${pattern}" dans ${path.basename(chemin)} :\n` +
                `─────────────────────────────────────────\n` +
                sortie +
                (resultats.length === (maxLignes ?? 30) ? "\n[…résultats tronqués, affiner le pattern]" : "")
            );
        } catch (e) {
            return `❌ Erreur grep : ${(e as Error).message}`;
        }
    },
    {
        name: "grep_memoire",
        description:
            "Cherche un mot, une phrase ou un pattern regex dans un fichier sauvegardé. " +
            "Idéal pour trouver une info précise dans un grand résultat HTML/texte " +
            "sans charger tout le fichier en mémoire. " +
            "Utilise ce tool après que lire_page_e2b ait sauvegardé son résultat sur disque.",
        schema: z.object({
            fichier    : z.string().describe("Chemin absolu ou relatif du fichier à fouiller"),
            pattern    : z.string().describe("Texte ou regex à rechercher (ex: 'email', 'href=', 'Erreur')"),
            maxLignes  : z.number().optional().default(30).describe("Nombre max de lignes à retourner (défaut: 30)"),
            ignoreCase : z.boolean().optional().default(true).describe("Ignorer la casse (défaut: true)"),
        }),
    }
);

/**
 * LIRE LIGNES — Lit une plage de lignes précise dans un fichier.
 * Équivalent de `sed -n '10,30p' fichier`
 */
export const lireLignes = tool(
    async ({ fichier, debut, fin }) => {
        try {
            const chemin = path.resolve(fichier);
            if (!fs.existsSync(chemin)) return `❌ Fichier introuvable : ${chemin}`;

            const lignes = fs.readFileSync(chemin, "utf-8").split("\n");
            const total  = lignes.length;

            const d = Math.max(1, debut ?? 1);
            const f = Math.min(total, fin ?? Math.min(d + 49, total)); // max 50 lignes par défaut

            const extrait = lignes
                .slice(d - 1, f)
                .map((l, i) => `L${String(d + i).padStart(4, "0")} │ ${l}`)
                .join("\n");

            return (
                `📄 ${path.basename(chemin)} — lignes ${d} à ${f} (total : ${total} lignes) :\n` +
                `─────────────────────────────────────────\n` +
                extrait
            );
        } catch (e) {
            return `❌ Erreur lire_lignes : ${(e as Error).message}`;
        }
    },
    {
        name: "lire_lignes",
        description:
            "Lit une plage de lignes précises dans un fichier (ex: lignes 10 à 40). " +
            "Utilise ce tool pour lire une section spécifique d'un grand fichier " +
            "sans charger tout son contenu en mémoire.",
        schema: z.object({
            fichier : z.string().describe("Chemin du fichier"),
            debut   : z.number().optional().describe("Numéro de la première ligne (commence à 1)"),
            fin     : z.number().optional().describe("Numéro de la dernière ligne"),
        }),
    }
);

/**
 * GLOB — Liste les fichiers correspondant à un pattern.
 * Équivalent de `ls ./agent-memory/tool-results/*.txt`
 */
export const rechercherGlob = tool(
    async ({ dossier, pattern }) => {
        try {
            const cheminDossier = path.resolve(dossier ?? MEMORY_DIR);
            if (!fs.existsSync(cheminDossier)) return `❌ Dossier introuvable : ${cheminDossier}`;

            // Glob manuel (pas de dépendance externe)
            const globPattern = pattern ?? "*";
            const regex = new RegExp(
                "^" + globPattern
                    .replace(/\./g, "\\.")
                    .replace(/\*/g, ".*")
                    .replace(/\?/g, ".") + "$"
            );

            const fichiers = fs.readdirSync(cheminDossier, { withFileTypes: true })
                .filter(e => e.isFile() && regex.test(e.name))
                .map(e => {
                    const chemin = path.join(cheminDossier, e.name);
                    const stats  = fs.statSync(chemin);
                    const taille = (stats.size / 1024).toFixed(1);
                    const date   = stats.mtime.toLocaleString("fr-FR");
                    return `📄 ${e.name.padEnd(55)} ${taille.padStart(7)} Ko   ${date}`;
                });

            if (fichiers.length === 0) {
                return `📂 Aucun fichier correspondant à "${globPattern}" dans ${cheminDossier}`;
            }

            return (
                `📂 ${fichiers.length} fichier(s) dans ${cheminDossier} (pattern: "${globPattern}") :\n` +
                `─────────────────────────────────────────\n` +
                fichiers.join("\n")
            );
        } catch (e) {
            return `❌ Erreur glob : ${(e as Error).message}`;
        }
    },
    {
        name: "rechercher_glob",
        description:
            "Liste les fichiers dans un dossier avec un filtre optionnel (* = wildcard). " +
            "Ex: pattern '*.txt' liste tous les fichiers texte, " +
            "'*navigation*' trouve les fichiers de navigation. " +
            "Dossiers disponibles : agent-memory/tool-results, agent-memory/plans, agent-memory/discoveries",
        schema: z.object({
            dossier : z.string().optional().describe(`Dossier à lister (défaut: ${MEMORY_DIR})`),
            pattern : z.string().optional().describe("Filtre glob (ex: '*.txt', '*screenshot*', '2024*')"),
        }),
    }
);

/**
 * ÉCRIRE DÉCOUVERTE — Sauvegarde une information importante trouvée pendant la navigation.
 * Permet à l'agent d'apprendre et de mémoriser sans saturer son contexte.
 */
export const ecrireDecouverte = tool(
    async ({ titre, contenu, tags }) => {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const nomFichier = `${timestamp}-${titre.slice(0, 30).replace(/[^a-zA-Z0-9]/g, "_")}.md`;
            const chemin = path.join(DISCOVERIES_DIR, nomFichier);

            const tagsStr = tags?.length ? `\nTags: ${tags.join(", ")}` : "";
            const contenuFichier =
                `# ${titre}\n` +
                `Date: ${new Date().toLocaleString("fr-FR")}${tagsStr}\n\n` +
                `---\n\n${contenu}\n`;

            fs.writeFileSync(chemin, contenuFichier, "utf-8");
            return `✅ Découverte sauvegardée : ${chemin}`;
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "ecrire_decouverte",
        description:
            "Sauvegarde une information importante trouvée pendant la navigation " +
            "(ex: structure d'un formulaire, sélecteur CSS trouvé, info de compte). " +
            "Utilise ce tool pour ne pas saturer le contexte avec des infos à retenir.",
        schema: z.object({
            titre   : z.string().describe("Titre court de la découverte"),
            contenu : z.string().describe("Contenu détaillé à sauvegarder"),
            tags    : z.array(z.string()).optional().describe("Tags pour faciliter la recherche (ex: ['formulaire', 'github'])"),
        }),
    }
);

/**
 * ÉCRIRE PLAN — Sauvegarde un plan d'action étape par étape.
 * L'agent peut écrire son plan avant d'exécuter pour le retrouver en cas de longue tâche.
 */
export const ecrirePlan = tool(
    async ({ tache, etapes, contexte }) => {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const nomFichier = `${timestamp}-plan.md`;
            const chemin = path.join(PLANS_DIR, nomFichier);

            const contenu =
                `# Plan : ${tache}\n` +
                `Date: ${new Date().toLocaleString("fr-FR")}\n` +
                (contexte ? `Contexte: ${contexte}\n` : "") +
                `\n## Étapes\n\n` +
                etapes.map((e, i) => `${i + 1}. [ ] ${e}`).join("\n") +
                "\n";

            fs.writeFileSync(chemin, contenu, "utf-8");
            return `✅ Plan sauvegardé : ${chemin}\nÉtapes : ${etapes.length}`;
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "ecrire_plan",
        description:
            "Sauvegarde un plan d'action avant d'exécuter une tâche complexe. " +
            "Permet de garder le fil directeur sans surcharger le contexte. " +
            "À utiliser en début de tâche longue (navigation + formulaire + création de compte).",
        schema: z.object({
            tache    : z.string().describe("Description de la tâche principale"),
            etapes   : z.array(z.string()).describe("Liste ordonnée des étapes à suivre"),
            contexte : z.string().optional().describe("Informations contextuelles utiles"),
        }),
    }
);

/**
 * APPRENDRE INSTRUCTION — Met à jour le fichier d'instructions évolutif.
 * Si l'utilisateur donne un conseil, l'agent l'écrit ici pour s'en souvenir.
 */
export const apprendreInstruction = tool(
    async ({ instruction, categorie }) => {
        try {
            const date = new Date().toLocaleString("fr-FR");
            const ajout =
                `\n## [${categorie ?? "Général"}] — ${date}\n` +
                `${instruction}\n`;

            fs.appendFileSync(INSTRUCTIONS_FILE, ajout, "utf-8");
            return `✅ Instruction mémorisée dans ${INSTRUCTIONS_FILE}`;
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "apprendre_instruction",
        description:
            "Mémorise une instruction ou un conseil donné par l'utilisateur pour les prochaines sessions. " +
            "Utilise ce tool quand l'utilisateur dit 'souviens-toi que...', 'toujours faire...', etc. " +
            "Les instructions sont persistées et rechargées à chaque démarrage.",
        schema: z.object({
            instruction : z.string().describe("L'instruction à mémoriser"),
            categorie   : z.string().optional().describe("Catégorie (ex: 'Navigation', 'Formulaires', 'Sécurité')"),
        }),
    }
);

/**
 * LIRE INSTRUCTIONS — Charge le fichier d'instructions évolutif.
 * L'agent peut le consulter en début de session.
 */
export const lireInstructions = tool(
    async () => {
        try {
            if (!fs.existsSync(INSTRUCTIONS_FILE)) {
                return "📝 Aucune instruction mémorisée pour l'instant.";
            }
            const contenu = fs.readFileSync(INSTRUCTIONS_FILE, "utf-8");
            if (contenu.trim().length < 100) {
                return "📝 Aucune instruction spécifique mémorisée.";
            }
            return `📚 Instructions mémorisées :\n\n${contenu}`;
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "lire_instructions",
        description:
            "Lit les instructions et conseils mémorisés lors des sessions précédentes. " +
            "À appeler en début de session longue ou après un 'reset'.",
        schema: z.object({}).optional(),
    }
);

/**
 * RÉSUMÉ SESSION — Génère un résumé de tous les fichiers créés dans la session.
 * Permet à l'agent de savoir ce qu'il a fait sans recharger tout le contexte.
 */
export const resumeSession = tool(
    async () => {
        try {
            const dossiers = [
                { dir: RESULTS_DIR,     label: "Résultats d'outils" },
                { dir: PLANS_DIR,       label: "Plans" },
                { dir: DISCOVERIES_DIR, label: "Découvertes" },
            ];

            const lignes: string[] = ["📊 Résumé de la session en cours :\n"];

            for (const { dir, label } of dossiers) {
                if (!fs.existsSync(dir)) continue;
                const fichiers = fs.readdirSync(dir).filter(f => !f.startsWith("."));
                lignes.push(`${label} (${fichiers.length} fichier(s)) :`);
                fichiers.slice(-5).forEach(f => {
                    const stats = fs.statSync(path.join(dir, f));
                    lignes.push(`  • ${f} (${(stats.size / 1024).toFixed(1)} Ko)`);
                });
                if (fichiers.length > 5) lignes.push(`  … et ${fichiers.length - 5} autre(s)`);
                lignes.push("");
            }

            return lignes.join("\n");
        } catch (e) {
            return `❌ Erreur : ${(e as Error).message}`;
        }
    },
    {
        name: "resume_session",
        description:
            "Affiche un résumé de tous les fichiers créés pendant la session " +
            "(résultats d'outils déchargés, plans, découvertes). " +
            "Utile pour reprendre le fil d'une longue tâche.",
        schema: z.object({}).optional(),
    }
);

// EXPORT

export const fsMemoryTools = [
    grepMemoire,
    lireLignes,
    rechercherGlob,
    ecrireDecouverte,
    ecrirePlan,
    apprendreInstruction,
    lireInstructions,
    resumeSession,
];