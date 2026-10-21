# KEUR Stats Tracker

Site de stats LoL (EUW) pour **I HATE HIM#KEUR** et **EvaNya#001**, mis à jour automatiquement toutes les heures via l'API Riot.

## Mise en ligne (une seule fois)

1. **Créer le dépôt** : sur github.com → bouton **New** → nom `keur-stats` → **Public** → *Create repository*.
2. **Envoyer les fichiers** : sur la page du dépôt → **uploading an existing file** → glisse **tout le contenu** du dossier (y compris le dossier `.github`) → *Commit changes*.
   - Si le dossier `.github` n'apparaît pas (fichier caché) : clique sur **Add file → Create new file**, tape `.github/workflows/update.yml` comme nom, et colle le contenu de ce fichier.
3. **Ajouter la clé Riot** : **Settings → Secrets and variables → Actions → New repository secret**
   - Name : `RIOT_API_KEY`
   - Secret : ta clé `RGAPI-…`
4. **Autoriser le script à écrire** : **Settings → Actions → General → Workflow permissions** → coche **Read and write permissions** → *Save*.
5. **Activer le site** : **Settings → Pages → Source : Deploy from a branch** → Branch **main**, dossier **/ (root)** → *Save*.
6. **Première mise à jour** : onglet **Actions** → **Mise à jour des stats** → **Run workflow**. La première fois, ça prend quelques minutes (et il peut falloir 2-3 exécutions pour récupérer toute la saison).

Le site est ensuite sur : `https://<ton-pseudo-github>.github.io/keur-stats/`
Lien direct vers un joueur : `…/keur-stats/?j=i-hate-him` ou `?j=evanya`.

## Au quotidien

- **Automatique** : toutes les heures.
- **Tout de suite après une partie** : Actions → Mise à jour des stats → **Run workflow**.
- **Ajouter un joueur** : modifie `players.json` (ajoute une ligne avec `slug`, `gameName`, `tagLine`).
- **Changer le site** : modifie `index.html` ; ton pote voit la nouvelle version en rechargeant la page.

## Bon à savoir

- La clé n'est jamais visible sur le site : elle reste dans les secrets GitHub.
- Si la clé change (New API Key sur le portail Riot), remplace juste le secret `RIOT_API_KEY`.
- GitHub met en pause les tâches automatiques d'un dépôt public après 60 jours sans activité ; si ça arrive, va dans Actions et réactive le workflow.
- Les stats par champion couvrent les parties classées (Solo/Duo + Flex) depuis la date `seasonStart` de `players.json`.
