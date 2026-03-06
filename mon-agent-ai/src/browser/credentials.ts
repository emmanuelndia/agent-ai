import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const opt = <T extends z.ZodTypeAny>(s: T) => s.optional().nullable();

// TYPES
interface Credential {
    id: string; 
    site: string;             // Nom lisible : "Github", "Twitter"
    url: string;              // URL de connexion
    email: string;            // Email ou username
    motDePasse: string;       // Mot de passe en clair (à chiffrer en prod)
    nom?: string;             // Nom affiché sur le site
    notes?: string;           // Infos supplémentaires
    createdAt?: Date;         // Date de création
    updatedAt?: Date;         // Date de modification
}

interface Store {
    version: string;
    credentials: Credential[]; 
}


// CLASSE GESTIONNAIRE
class GestionnaireCredentials {
    private fichier: string;
    private store: Store;
    
    constructor() {
        this.fichier = path.resolve("./credentials.json");
        this.store = this.charger();
    }

    private charger(): Store {
        try {
            if (fs.existsSync(this.fichier)) {
                const data = JSON.parse(fs.readFileSync(this.fichier, "utf-8"));
                // Convert string dates back to Date objects
                data.credentials = data.credentials.map((cred: any) => ({
                    ...cred,
                    createdAt: cred.createdAt ? new Date(cred.createdAt) : undefined,
                    updatedAt: cred.updatedAt ? new Date(cred.updatedAt) : undefined
                }));
                return data;
            }
        } catch (e) {
            console.error("Erreur lors du chargement des credentials :", e);
        }
        return { version: "1.0", credentials: [] };
    } 

    private persister() {
        fs.mkdirSync(path.dirname(this.fichier), { recursive: true});
        fs.writeFileSync(this.fichier, JSON.stringify(this.store, null, 2), "utf-8");
    }

    sauvegarder(data: Omit<Credential, "id" | "createdAt" | "updatedAt">): Credential {
        const now = new Date();

        // Mise à jour si déjà existant
        const existant = this.store.credentials.find(
            (c) =>
                c.site.toLowerCase() === data.site.toLowerCase() &&
                c.email.toLowerCase() === data.email.toLowerCase()
        );

        if (existant) {
            Object.assign(existant, {...data, updatedAt: now});
            this.persister();
            return existant;
        }

        // Nouveau 
        const nouveau: Credential = {id: crypto.randomUUID(), ...data, createdAt: now, updatedAt: now};
        this.store.credentials.push(nouveau);
        this.persister();
        return nouveau;
    }

    trouver(site: string, email?: string): Credential | null {
    const correspondances = this.store.credentials.filter((c) =>
      c.site.toLowerCase().includes(site.toLowerCase()) ||
      c.url.toLowerCase().includes(site.toLowerCase())
    );
    if (email) {
      return correspondances.find((c) => c.email.toLowerCase() === email.toLowerCase()) ?? null;
    }
    return correspondances[0] ?? null;
  }

  listerTous(): Credential[] {
    return this.store.credentials;
  }

  supprimer(id: string): boolean {
    const avant = this.store.credentials.length;
    this.store.credentials = this.store.credentials.filter((c) => c.id !== id);
    if (this.store.credentials.length < avant) {
      this.persister();
      return true;
    }
    return false;
  }

  generateMotDePasse(longueur = 16): string {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_";
    const bytes = crypto.randomBytes(longueur);
    return Array.from(bytes)
      .map((b) => chars[b % chars.length])
      .join("");
  }
}

export const creds = new GestionnaireCredentials();


// TOOLS CREDENTIALS
export const sauvegarderCredential = tool(
    async ({ site, url, email, motDePasse, nom, notes}) => {
        const saved = creds.sauvegarder({ site, url, email, motDePasse, nom, notes});
        return `Credentials sauvergadés !
            Site : ${saved.site}
            URL : ${saved.url}
            Email : ${saved.email}
            Mot de passe : ${saved.motDePasse}
            ID : ${saved.id}
            Date : ${saved.createdAt}`;
    },
    {
        name: "sauvegarder_credential",
        description: 
            "Sauvegarde des identifiants de connexion après création ou modification d'un compte. TOUJOURS appeler après inscription réussie.",
        schema: z.object({
            site: z.string().describe("Nom du site, ex: 'Github', 'Twitter', 'Reddit"),
            url: z.string().describe("URL de la page de connexion"),
            email: z.string().describe("Email ou nom d'utilisateur"),
            motDePasse: z.string().describe("Mot de passe utilisé"),
            nom: opt(z.string()).describe("Nom affiché / pseudo sur le site"),
            notes: opt(z.string()).describe("Notes additionnelles"),
        }),    
    }
);

export const lireCredential = tool(
    async ({ site, email }) => {
        const cred = creds.trouver(site, email);
        if (!cred) {
            return `Aucun credential trouvé pour "${site}". Utilise lister_credentials pour voir tous les comptes.`;
        }
        return `Credential trouvé :
            Site    : ${cred.site}
            URL     : ${cred.url}
            Email   : ${cred.email}
            MDP     : ${cred.motDePasse}
            Nom     : ${cred.nom ?? "N/A"}
            Notes   : ${cred.notes ?? "N/A"}`;
    },
    {
        name: "lire_credential",
        description: "Récupère les identifiants suavegardés pour un site",
        schema: z.object({
            site: z.string().describe("Nom ou URL du site"),
            email: opt(z.string()).describe("Email spécifique si plusieurs comptes"),
        }),
    }
);

export const listerCredentials = tool(
    async () => {
        const liste = creds.listerTous();
        if (!liste.length) return "Aucun credential sauvegardé pour l'instant.";
        return `Credentials sauvergadés (${liste.length}) : \n\n` +
            liste.map((c, i) =>
                `${i + 1}. ${c.site}\n   Email: ${c.email}\n  URL: ${c.url}\n   Ajouté: ${c.createdAt?.toISOString().slice(0, 10)}`
            ).join("\n\n")
    },
    {
        name: "lister_credentials",
        description: "Liste tous les comptes et identifiants sauvegardés.",
        schema: z.object({}).nullable().optional(),
    }
);

export const generateMotDePasse = tool(
    async ({ longueur }) => {
        const mdp = creds.generateMotDePasse(longueur);
        return `Mot de passe généré (${longueur} caractères : ${mdp})`;
    },
    {
        name: "generate_mot_de_passe",
        description:
            "Génère un mot de passe fort et aléatoire. Génère toujours un MDP avant de créer un compte.",
        schema: z.object({
            longueur: z.number().int().min(8).max(64).default(16),
        }),
    }
);

export const credentialTools = [
  sauvegarderCredential,
  lireCredential,
  listerCredentials,
  generateMotDePasse,
];