# EPOCH — The Living World

Simulateur de civilisation 3D dans le navigateur : une planète procédurale sur laquelle des milliers
d’individus autonomes écriront leur histoire, observés et influencés par le joueur-divinité.

> « Avant les royaumes, avant les guerres, avant les légendes, il n’existait qu’un monde. »

Le projet est développé par phases (voir [docs/ROADMAP.md](docs/ROADMAP.md)). **État actuel : phase 1 — le socle visuel.**

## Lancer

```bash
npm install
npm run dev        # serveur de développement (http://localhost:5173)
npm test           # tests automatisés (Vitest)
npm run build      # vérification des types + build de production dans dist/
```

Aucun serveur ni service externe n’est requis : tout fonctionne hors ligne (polices embarquées,
génération locale, sauvegardes dans IndexedDB). Navigateur moderne avec WebGL2 requis.

## Commandes

| Action | Souris | Clavier |
| --- | --- | --- |
| Parcourir le monde | glisser, clic gauche | `W` `A` `S` `D` / flèches (`Maj` : plus vite) |
| Zoom continu orbite ↔ sol | molette | `R` / `F` |
| Pivoter, incliner | glisser, clic droit (ou `Maj` + clic gauche) | `Q` / `E` |
| Examiner une terre ou un bâtiment | clic gauche | |
| Pause / vitesses | barre du haut | `Espace`, `1`–`4` |
| Diagnostic de performance | bouton « Diagnostic » | `F3` |

## Ce que contient la phase 1

- **Planète procédurale déterministe** à partir d’une graine : continents, îles, chaînes de montagnes,
  volcans, océans, rivières qui suivent réellement la topographie, lacs, climats, biomes, fertilité,
  biodiversité, gisements (fer, charbon, or, pierre) et repérage des terres propices à l’installation.
- **Rendu 3D** : terrain sphérique à niveaux de détail (quadtree), océan animé, diffusion atmosphérique
  (ciel, couchers de soleil, limbe vu de l’espace), nuages et leurs ombres, forêts instanciées,
  ombres portées, cycle jour/nuit, saisons (neiges, feuillages d’automne, banquise).
- **Caméra continue** de la vue stratégique (orbite) à la vue immersive (au sol).
- **Premiers bâtiments** : 13 modèles procéduraux, assemblés en hameaux fondateurs sur les meilleurs sites.
- **Interface** : écran d’ouverture, HUD, panneaux Monde et Atlas (9 cartes tirées des données réelles),
  fiches d’inspection, tutoriel, diagnostic, sauvegardes (auto + 3 emplacements, export/import).

Les sections Population, Civilisations, Économie, Politique, Histoire, Chroniques et Divinité sont
verrouillées dans l’interface tant que leurs systèmes n’existent pas : aucune donnée fictive n’est affichée.

Architecture détaillée : [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
