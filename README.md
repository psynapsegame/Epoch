# EPOCH — The Living World

Jeu mobile de simulation de civilisation en 3D, pour **iPhone et Android** : une planète procédurale
sur laquelle des milliers d’individus autonomes écriront leur histoire, observés et influencés par le
joueur-divinité. Paysage, tactile, hors ligne.

> « Avant les royaumes, avant les guerres, avant les légendes, il n’existait qu’un monde. »

Le projet est développé par phases (voir [docs/ROADMAP.md](docs/ROADMAP.md)). **État actuel : phase 8 — polissage et passage à l’échelle** (livrée en partie : ce qui reste est listé dans la feuille de route).

## Lancer

```bash
npm install
npm run dev        # serveur de développement (http://localhost:5173)
npm test           # tests automatisés (Vitest)
npm run build      # vérification des types + build de production dans dist/
```

Applications natives (Capacitor) :

```bash
npm run android    # build + synchronisation + ouverture d’Android Studio
npm run ios        # build + synchronisation + ouverture de Xcode (macOS)
npm run dev:host   # test rapide sur téléphone via le réseau local
```

Aucun serveur ni service externe n’est requis : tout fonctionne hors ligne (polices embarquées,
génération locale, sauvegardes locales). Guide complet : [docs/MOBILE.md](docs/MOBILE.md).

## Commandes

| Action | Tactile | Souris / clavier |
| --- | --- | --- |
| Parcourir le monde | glisser un doigt | glisser clic gauche, `W` `A` `S` `D` |
| Zoom continu orbite ↔ sol | pincer | molette, `R` / `F` |
| Pivoter | tourner deux doigts | glisser clic droit, `Q` / `E` |
| Incliner | glisser deux doigts ensemble | glisser clic droit |
| Examiner | toucher | clic gauche |
| Pause / vitesses | barre du haut | `Espace`, `1`–`4` |
| Diagnostic | Monde → Affichage et énergie | `F3` |

## Ce que contient la phase 1

- **Planète procédurale déterministe** à partir d’une graine : continents, îles, chaînes de montagnes,
  volcans, océans, rivières qui suivent réellement la topographie, lacs, climats, biomes, fertilité,
  biodiversité, gisements (fer, charbon, or, pierre) et repérage des terres propices à l’installation.
- **Rendu 3D** : terrain sphérique à niveaux de détail (quadtree), océan animé, diffusion atmosphérique
  (ciel, couchers de soleil, limbe vu de l’espace), nuages et leurs ombres, forêts instanciées,
  ombres portées, cycle jour/nuit, saisons (neiges, feuillages d’automne, banquise).
- **Caméra continue** de la vue stratégique (orbite) à la vue immersive (au sol).
- **Premiers bâtiments** : 13 modèles procéduraux, assemblés en hameaux fondateurs sur les meilleurs sites.
- **Interface** tactile : écran d’ouverture, HUD, panneaux Monde et Atlas (cartes tirées des données réelles),
  fiches d’inspection, tutoriel, diagnostic, sauvegardes (auto + 3 emplacements, export/import).
- **Mobile** : gestes tactiles, mise en page paysage compacte, paliers de qualité et gouverneur adaptatif,
  cadence d’images économe, PWA hors ligne, projets natifs iOS et Android.

## Ce que contient la phase 2

- **100 habitants autonomes** répartis en familles dans les hameaux fondateurs : identité, apparence,
  personnalité (9 traits), besoins (6), savoir-faire, liens, souvenirs datés.
- **Décisions par utilité** : chacun choisit selon ses besoins, son tempérament, l’heure, la saison et
  les réserves de son foyer. Cueillette portée au garde-manger, repas, sommeil nocturne, discussions,
  amitiés et brouilles, exploration, entraide — et la faim tue si la terre ne nourrit plus.
- **Simulation déterministe dans un Web Worker**, indépendante de l’affichage ; la société entière est
  sauvegardée et reprend à l’identique.
- **Rendu instancié** des habitants, sélection au toucher, fiche individuelle vivante, suivi caméra,
  panneau Population.

Détails : [docs/SIMULATION.md](docs/SIMULATION.md).

## Ce que contient la phase 3

- **Dix métiers aux fonctions réelles** (agriculteur, éleveur, pêcheur, bûcheron, mineur, bâtisseur,
  forgeron, artisan, marchand, cueilleur), attribués chaque jour selon les besoins et les aptitudes.
- **Économie** : huit ressources, greniers, prix qui suivent la rareté, monnaie conservée, commerce
  entre établissements par des marchands qui voyagent réellement.
- **Construction par les habitants** : la communauté choisit ses chantiers, les bâtisseurs y consomment
  les matériaux en stock, les bâtiments s’élèvent progressivement.
- **Générations** : unions, naissances, hérédité, foyers qui se forment, mort de vieillesse.
- **Conséquences** : mauvaises récoltes, famines, chantiers arrêtés faute de matériaux, pas d’outils sans fer.

Détails : [docs/ECONOMY.md](docs/ECONOMY.md).

## Ce que contient la phase 4

- **Peuples** avec capitale, terres, couleurs, culture, croyances et savoir.
- **Dirigeants réels**, successions (élection, héritage), maisons régnantes, coups de force et révoltes,
  trois régimes (chefferie, monarchie, conseil des sages).
- **Cultures** transmises aux enfants, grande fête annuelle ; **croyances** qui naissent, se propagent,
  se divisent et s’éteignent.
- **17 technologies** qui changent réellement rendements, outils, chantiers, commerce, mortalité.
- **Colonisation** des terres vides par des familles qui voyagent réellement.
- **Histoire** : journal de tous les faits, archives de tous les défunts, cartes des frontières, de la
  population et des religions.

Détails : [docs/CIVILIZATIONS.md](docs/CIVILIZATIONS.md).

## Ce que contient la phase 5

- **Diplomatie** : opinion entre peuples, alliances, causes de tension réelles.
- **Guerres** : levées de soldats, armées qui marchent, sièges, batailles où meurent de vrais
  habitants, conquêtes, traités de paix, soulèvements et sécessions.

Détails : [docs/WAR.md](docs/WAR.md).

## Ce que contient la phase 6

- **14 pouvoirs divins** : bénir, protéger, susciter un être d’exception, faire naître une forêt ou un
  gisement, élever une montagne, creuser une vallée, déchaîner tempête, sécheresse, incendie, météorite…
- Chaque acte change réellement la planète ou la société, de façon durable et sauvegardée.
- Les peuples **interprètent** ces prodiges selon leurs croyances : ferveur, doute, naissance d’un culte.

Détails : [docs/DIVINITY.md](docs/DIVINITY.md).

## Ce que contient la phase 7

- **Annales du monde** et **chroniques des peuples** rédigées à partir des seuls faits enregistrés ;
  toucher une phrase montre ses sources.
- **Annales chiffrées** exactes, année par année ; **récits de vie** ; **arbres généalogiques** des
  vivants et des morts ; export des récits.

Détails : [docs/CHRONICLES.md](docs/CHRONICLES.md).

## Ce que contient la phase 8

- **Traverser le temps** : « + 1 / 10 / 50 ans » simule réellement les années à pleine puissance,
  avec progression et arrêt à tout moment.
- **Passage à l’échelle** : simulation mesurée jusqu’à 3 630 habitants ; état de sauvegarde transmis
  en texte ; bâtiments dessinés par bourg.
- **Fumée des foyers** au-dessus des seules maisons habitées ; **carte des routes commerciales**
  tracée d’après les marchandises réellement transportées.
- **Diagnostic** enrichi du coût de la simulation.

Mesures et limites : [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Routes et murailles

Les bourgs tracent leurs **rues** et leurs **grands chemins**, et se ceignent d’une **palissade** ou
d’un **mur de pierre** percé de portes quand ils se sentent menacés. Ce sont de vrais chantiers
(heures, bois, pierre) aux effets réels : marche et commerce plus rapides, défense renforcée,
passage par les portes. Détails et limites : [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md).

Architecture détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
