import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { navigateur } from "./browser-manager";

// TOOL : DIAGNOSTIC NAVIGATEUR
export const diagnosticNavigateur = tool(
    async () => {
        try {
            const page = navigateur.getPage();
            const diagnostic = {
                url: page.url(),
                titre: await page.title(),
                estActif: navigateur.estActif(),
                estVisible: await page.isVisible('body'),
                nombreInputs: await page.locator('input').count(),
                nombreBoutons: await page.locator('button').count(),
                htmlBody: (await page.locator('body').innerHTML()).slice(0, 1000) + '...'
            };
            return `🔍 Diagnostic navigateur :
- URL : ${diagnostic.url}
- Titre : ${diagnostic.titre}
- Navigateur actif : ${diagnostic.estActif}
- Body visible : ${diagnostic.estVisible}
- Inputs trouvés : ${diagnostic.nombreInputs}
- Boutons trouvés : ${diagnostic.nombreBoutons}
- Aperçu HTML : ${diagnostic.htmlBody}`;
        } catch (e) {
            return `❌ Erreur diagnostic : ${(e as Error).message}`;
        }
    },
    {
        name: "diagnostic_navigateur",
        description: "Fait un diagnostic complet de l'état du navigateur et de la page actuelle",
        schema: z.object({}),
    }
);

// TOOL : TESTER SELECTEUR
export const testerSelecteur = tool(
    async ({ selecteur }) => {
        try {
            const page = navigateur.getPage();
            const element = page.locator(selecteur);
            const count = await element.count();
            const visible = count > 0 ? await element.first().isVisible() : false;
            const enabled = count > 0 ? await element.first().isEnabled() : false;
            
            return `🧪 Test sélecteur "${selecteur}" :
- Éléments trouvés : ${count}
- Premier visible : ${visible}
- Premier enabled : ${enabled}
- Tag : ${count > 0 ? await element.first().evaluate(el => el.tagName) : 'N/A'}`;
        } catch (e) {
            return `❌ Erreur test sélecteur : ${(e as Error).message}`;
        }
    },
    {
        name: "tester_selecteur",
        description: "Test si un sélecteur CSS fonctionne sur la page actuelle",
        schema: z.object({
            selecteur: z.string().describe("Sélecteur CSS à tester"),
        }),
    }
);

export const debugTools = [diagnosticNavigateur, testerSelecteur];
