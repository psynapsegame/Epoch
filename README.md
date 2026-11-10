# EPOCH — The Living World

Jeu mobile de simulation de civilisation en 3D, pour **iPhone et Android** : une planète procédurale
sur laquelle des milliers d’individus autonomes écriront leur histoire, observés et influencés par le
joueur-divinité. Paysage, tactile, hors ligne.

> « Avant les royaumes, avant les guerres, avant les légendes, il n’existait qu’un monde. »

Le projet est développé par phases (voir [docs/ROADMAP.md](docs/ROADMAP.md)). **État actuel : phase 1 — le socle visuel.**

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

Les sections Population, Civilisations, Économie, Politique, Histoire, Chroniques et Divinité sont
verrouillées dans l’interface tant que leurs systèmes n’existent pas : aucune donnée fictive n’est affichée.

Architecture détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
