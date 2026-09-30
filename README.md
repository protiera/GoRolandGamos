# Roland Gamos 🎤

Le ping-pong de featurings rap, en multijoueur en ligne. Pas de compte, juste un pseudo et un lien d'invitation.
Inspiré de [QuentinAM/roland-gamos](https://github.com/QuentinAM/roland-gamos) et du Roland Gamos de Rap Jeu.

## Règles

1. Un joueur (tiré au sort) choisit l'artiste de départ.
2. Chacun son tour, cite un artiste qui a un feat avec le dernier artiste de la chaîne.
3. Un artiste ne peut être cité qu'une fois (tentative refusée sans pénalité, tu peux réessayer).
4. Pas de feat trouvé ou temps écoulé : tu perds une vie.
5. Le dernier joueur en vie gagne.

L'hôte règle le temps par tour (10 à 60 s) et le nombre de vies (1 à 5).

## Stack

- **Serveur** : Node.js ≥ 20, Express, Socket.io. L'état des rooms est en mémoire.
- **Front** : HTML/CSS/JS vanilla dans `public/`, sans étape de build.
- **Données** : [API publique Deezer](https://developers.deezer.com/api), sans clé. Un feat est validé si un morceau
  trouvé par la recherche « A B » a les deux artistes dans son titre (`feat. X`) ou dans ses contributeurs.
  Les appels sont mis en cache 6 h et limités à 40 requêtes / 5 s (le quota Deezer est d'environ 50 / 5 s par IP).

```
server/
  index.js    # HTTP + événements Socket.io
  game.js     # rooms, tours, timer, vies
  deezer.js   # recherche d'artistes et vérification des feats
public/
  index.html  style.css  app.js
```

## Lancer en local

```bash
npm install
npm run dev      # http://localhost:3000, redémarre à chaque modif
```

Pour tester à plusieurs, ouvre plusieurs onglets : chaque onglet est un joueur différent.

## Déployer sur Railway

1. Pousse le projet sur un repo GitHub.
2. Sur Railway : **New Project → Deploy from GitHub repo**, puis choisis le repo.
3. Railway détecte Node, lance `npm install` puis `npm start`, et fournit la variable `PORT`. Rien à configurer.
4. Dans **Settings → Networking**, clique sur **Generate Domain** pour obtenir l'URL publique.
5. Optionnel : healthcheck sur `/health`.

⚠️ Les rooms sont stockées en mémoire. Un redéploiement coupe les parties en cours, et il faut garder
**une seule instance** (pas de réplicas), sinon deux joueurs peuvent atterrir sur des serveurs différents.

## Limites connues

- Deezer ne connaît pas tous les feats (morceaux non distribués, freestyles, mixtapes rares). Un vrai feat peut
  donc être refusé à l'occasion.
- En cas d'homonymes, prends l'artiste proposé dans l'autocomplétion, qui affiche le nombre de fans pour les
  distinguer.
