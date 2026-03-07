# Analyse et Correction des Erreurs dans le Projet `agent-ai`

## Introduction

Ce rapport détaille l'analyse des erreurs rencontrées dans le projet `agent-ai`, spécifiquement celles liées à la gestion du contexte, aux limites de débit (rate limits) des modèles de langage (LLM) et à la sanitisation des messages. L'objectif est d'identifier les causes profondes de ces problèmes et de proposer des solutions ciblées pour améliorer la robustesse et l'efficacité de l'agent.

## Contexte des Erreurs

Les logs d'erreur fournis mettent en évidence plusieurs problèmes récurrents lors de l'interaction avec différents fournisseurs de LLM (Mistral, Groq). Ces erreurs peuvent être regroupées en trois catégories principales :

1.  **Erreurs de rôle de message (`Expected last role User or Tool...`)** : Indiquent une incompatibilité dans l'ordre des messages envoyés aux API des LLM, en particulier Mistral.
2.  **Limites de débit (`RATE_LIMIT: 429`)** : Suggèrent que l'agent dépasse les quotas de requêtes autorisés par les fournisseurs de LLM, malgré un mécanisme de gestion des limites de débit.
3.  **Requêtes trop volumineuses (`Request too large for model`)** : Révèlent que le contexte envoyé à certains modèles LLM dépasse leur fenêtre de contexte maximale, notamment pour les modèles Groq avec une fenêtre plus petite.
4.  **Messages d'outils orphelins (`ToolMessage orphelin ignoré`)** : Des avertissements indiquant que des messages d'outils sont présents sans un message d'assistant parent valide, potentiellement dû à une construction incorrecte de l'historique des messages.

## Analyse Détaillée et Causes Racines

### 1. Erreurs de Rôle de Message (Mistral)

L'erreur `Expected last role User or Tool (or Assistant with prefix True) for serving but got assistant` est spécifique à l'API de Mistral. Elle survient lorsque le dernier message dans l'historique de conversation est un `AIMessage` (message de l'assistant) alors que l'API attend un `HumanMessage` ou un `ToolMessage` pour initier la prochaine interaction. Le code dans `agent-complet.ts` inclut une fonction `sanitiserMessages` qui tente de corriger cela en ajoutant un `HumanMessage` de relance si le dernier message est un `AIMessage` vide ou avec du contenu. Cependant, l'occurrence persistante de cette erreur dans les logs suggère que :

*   La logique de sanitisation n'est pas toujours appliquée au bon moment ou sur le bon ensemble de messages.
*   Il pourrait y avoir des chemins de code où un `AIMessage` est ajouté à l'historique et devient le dernier message sans passer par la sanitisation adéquate avant l'appel à l'API.
*   Le `HumanMessage` de relance ajouté par la sanitisation n'est pas toujours suffisant pour satisfaire la contrainte de l'API Mistral, surtout si l'AIMessage précédent contenait des `tool_calls` non résolus.

### 2. Limites de Débit (Groq)

Les erreurs `RATE_LIMIT: 429` indiquent que les requêtes vers les API Groq sont trop fréquentes. Bien que le `MultiProviderLLM` implémente un `RateLimiter` avec une logique de `sleep` et de réessai exponentiel, les échecs répétés suggèrent que :

*   Les `rpm` (requêtes par minute) configurés pour les fournisseurs Groq (`25` dans `PROVIDERS_CHAIN`) pourraient être trop optimistes ou ne pas correspondre aux limites réelles imposées par l'API Groq, surtout pour des périodes prolongées.
*   Le mécanisme de `sleep` pourrait ne pas être suffisamment long ou ne pas prendre en compte des fenêtres de temps plus larges (par exemple, requêtes par heure ou par jour) qui ne sont pas gérées par le `RateLimiter` actuel.
*   La logique de `maxRetries` (3 tentatives) est rapidement épuisée, ce qui force le passage au fournisseur suivant, mais ne résout pas le problème fondamental de dépassement de la limite de débit.

### 3. Requêtes Trop Volumineuses (Groq llama-3.1-8b)

L'erreur `Request too large for model` avec le statut HTTP 413, spécifiquement pour `llama-3.1-8b-instant`, est critique. Ce modèle a une fenêtre de contexte plus petite (~8K tokens) que d'autres. Le `AdvancedContextManager` est conçu pour compresser le contexte via la génération de résumés et l'offload vers le système de fichiers. Cependant, l'erreur indique que :

*   La compression du contexte n'est pas assez agressive ou ne se déclenche pas suffisamment tôt pour les modèles à petite fenêtre de contexte.
*   Le `compressionThreshold` (0.8) et `keepLastNMessages` (5) pourraient ne pas être optimaux pour tous les modèles, en particulier ceux avec des contraintes de tokens strictes.
*   Le 
mécanisme de `offloadSiVolumineux` dans `toolNodeAvecOffload` est bien présent, mais il se peut que les messages `ToolMessage` ne soient pas toujours les seuls contributeurs majeurs à la taille du contexte, ou que l'offload ne réduise pas suffisamment la taille pour les modèles les plus restrictifs.

### 4. Messages d'Outils Orphelins

Les avertissements `⚠️ Sanitise P1 : ToolMessage orphelin ignoré` indiquent que des `ToolMessage` sont détectés sans un `AIMessage` parent valide qui aurait initié l'appel à l'outil. Cela peut se produire si :

*   Un `AIMessage` avec `tool_calls` est supprimé par une étape de sanitisation précédente (par exemple, `P0A` ou `P0C`) mais les `ToolMessage` correspondants ne le sont pas.
*   Il y a une désynchronisation entre la manière dont les `AIMessage` et `ToolMessage` sont ajoutés ou supprimés de l'historique des messages.
*   Certains fournisseurs LLM génèrent des `AIMessage` avec des `tool_calls` qui ne sont pas correctement interprétés ou associés aux `ToolMessage` subséquents par la logique de LangChain ou du projet.

## Solutions Proposées

Pour résoudre ces problèmes, les actions suivantes sont recommandées :

### 1. Amélioration de la Sanitisation des Messages

*   **Révision de la logique `sanitiserMessages`** : S'assurer que la suppression des `AIMessage` (notamment ceux sans contenu ou `tool_calls` valides) entraîne également la suppression des `ToolMessage` orphelins associés. La passe `P0B` et `P0C` devraient être plus robustes dans la gestion des `tool_calls` sans ID ou mal formatés.
*   **Normalisation des `tool_calls`** : Renforcer la normalisation des `additional_kwargs.tool_calls` pour s'assurer qu'ils sont toujours dans un format compatible OpenAI avec des IDs valides, même si le fournisseur original les fournit différemment. La logique actuelle tente de le faire, mais des cas limites peuvent exister.
*   **Gestion des `AIMessage` terminaux** : La passe 4 qui ajoute un `HumanMessage` de relance est une bonne approche. Il faut s'assurer qu'elle est toujours déclenchée et qu'elle est suffisante pour satisfaire les contraintes de rôle de Mistral. Une alternative pourrait être de supprimer l'AIMessage terminal si aucun `ToolMessage` ne le suit et qu'il n'a pas de contenu significatif.

### 2. Optimisation de la Gestion des Limites de Débit

*   **Ajustement des `rpm`** : Réévaluer les valeurs `rpm` pour chaque fournisseur dans `PROVIDERS_CHAIN` en fonction des limites documentées et de l'expérience réelle. Il pourrait être nécessaire de les rendre plus conservatrices.
*   **Stratégie de réessai plus agressive** : Pour les erreurs `RATE_LIMIT`, au lieu de simplement attendre et réessayer, envisager une stratégie qui augmente le temps d'attente de manière plus significative ou qui met le fournisseur en 
cooldown pour une durée plus longue si les réessais échouent de manière répétée. L'implémentation actuelle de `rateLimitedUntil` est un bon début, mais la durée du cooldown pourrait être ajustée dynamiquement en fonction de la persistance des erreurs de `RATE_LIMIT`.
*   **Surveillance et Alertes** : Mettre en place une surveillance pour les dépassements de limites de débit afin d'ajuster proactivement les configurations ou d'alerter l'utilisateur.

### 3. Amélioration de la Gestion du Contexte pour les Modèles Restrictifs

*   **Ajustement dynamique des paramètres de compression** : Adapter le `compressionThreshold` et `keepLastNMessages` en fonction du modèle LLM actuellement utilisé. Les modèles avec une fenêtre de contexte plus petite (comme `llama-3.1-8b`) devraient avoir des seuils de compression plus bas et/ou un nombre plus faible de messages récents conservés.
*   **Compression plus agressive** : Explorer des stratégies de résumé plus agressives ou des techniques de troncature si la compression actuelle ne suffit pas. Cela pourrait inclure la suppression de messages moins pertinents ou la réduction de la longueur des messages individuels avant l'envoi à l'API.
*   **Détection précoce de la taille du contexte** : Intégrer une vérification de la taille du contexte (en tokens) avant d'appeler `multiLLM.invoke`. Si la taille dépasse un seuil prédéfini pour le modèle cible, déclencher la compression ou le fallback vers un modèle avec une fenêtre de contexte plus grande plus tôt.

### 4. Résolution des Messages d'Outils Orphelins

*   **Synchronisation de la suppression** : Lors de la suppression d'un `AIMessage` avec `tool_calls` (par exemple, dans les passes `P0A`, `P0B`, `P0C` de `sanitiserMessages`), s'assurer que tous les `ToolMessage` correspondants (ceux avec le même `tool_call_id`) sont également supprimés de l'historique. Cela garantira la cohérence de l'historique des messages.
*   **Vérification de la validité des `tool_call_id`** : S'assurer que chaque `ToolMessage` a un `tool_call_id` valide et qu'il correspond à un `tool_call` existant dans le `AIMessage` précédent. Si ce n'est pas le cas, le `ToolMessage` devrait être traité comme invalide ou orphelin et supprimé.

## Conclusion

Les erreurs rencontrées dans le projet `agent-ai` sont principalement liées à des incompatibilités de format de message avec certains LLM, des dépassements de limites de débit et des requêtes trop volumineuses. Les solutions proposées visent à renforcer la robustesse du système de gestion du contexte et des interactions avec les API des LLM. En mettant en œuvre ces correctifs, l'agent devrait être plus stable, plus efficace et moins sujet aux interruptions dues aux contraintes des fournisseurs de modèles de langage.
