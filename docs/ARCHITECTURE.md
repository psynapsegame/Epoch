# Architecture

> Cible : **smartphones iOS et Android** (paysage, tactile, hors ligne). Voir [MOBILE.md](MOBILE.md) pour
> l’enveloppe native, les gestes, les paliers de qualité et la gestion de l’énergie.

## Principes

1. **Séparation stricte simulation / rendu / interface.** La simulation (`src/world`, `src/sim`, `src/core`)
   ne dépend ni de Three.js ni du DOM : elle tourne telle quelle dans Node (tests) et dans des Web Workers.
   Le rendu (`src/render`) *lit* l’état du monde et n’y écrit jamais. L’interface (`src/ui`) appelle
   uniquement l’orchestrateur `Game`.
2. **Déterminisme.** Tout aléa passe par `core/rng.ts` (PRNG à état sérialisable) et `core/noise.ts`
   (simplex à graine). `Math.random()` est interdit dans `world/` et `sim/` (il n’est utilisé que pour
   proposer une graine sur l’écran titre). Même graine ⇒ même monde, bit pour bit, sur un même moteur JS.
3. **Données en tableaux typés.** Le monde est une grille équirectangulaire de champs (`Float32Array`,
   `Uint8Array`…), transférable entre threads sans copie et sérialisable directement.
4. **Rien de fictif.** Tout ce que l’interface affiche provient d’un champ ou d’un compteur réel.

## Organisation

```
src/
  core/         rng.ts · noise.ts · math.ts                (briques déterministes)
  world/        types.ts          modèle de données du monde
                generator.ts      pipeline de génération (pur)
                worldgen.worker.ts / generateAsync.ts      exécution hors du thread principal
                world.ts          API de requête : altitude continue, lancer de rayon, description
                names.ts          toponymie procédurale
  sim/          clock.ts          horloge historique (360 j/an, 4 saisons, vitesses)
                settlements.ts    implantation des bâtiments validée contre le terrain
  render/       engine.ts         scène, lumière, ombres, post-traitement, picking, diagnostics
                terrain.ts        quadtree cube-sphère, LOD, culling, forêts instanciées
                terrainMaterial.ts  shader du sol piloté par les champs du monde
                ocean.ts · sky.ts · atmospherePass.ts
                worldTextures.ts  champs du monde → textures GPU, cartes de l’Atlas
                cameraController.ts  caméra orbite ↔ sol (tactile multi-points, souris, clavier)
                gestures.ts       mathématiques des gestes à deux doigts (pur)
                quality.ts        paliers de qualité, gouverneur adaptatif, cadence d’images (pur)
                buildingsLayer.ts · models/ (bâtiments, arbres procéduraux)
                shared.ts         uniforms et GLSL communs, greffe sur MeshStandardMaterial
  persistence/  saveStore.ts      IndexedDB + miroir fichiers natif, format versionné, export/import
  platform/     platform.ts       différences navigateur / PWA / natif (Capacitor), partage, cycle de vie
  settings.ts   préférences du joueur (qualité, économie d’énergie)
  ui/           app.ts · styles.css · icons.ts
  game.ts       orchestrateur : horloge + monde + état + rendu + sauvegarde
android/ ios/   projets natifs Capacitor (paysage, plein écran)
tests/          Vitest : générateur, hydrologie, API monde, horloge, RNG, hameaux, sauvegardes, gestes, gouverneur
```

## Le monde

- Planète miniature stylisée : rayon 3 200 m (≈ 20 km de circonférence), grille 2048 × 1024
  (≈ 10 m par cellule à l’équateur). Un bâtiment occupe environ une cellule.
- Pipeline (`generator.ts`) : continents (fbm 3D déformé, seuil par histogramme pondéré par l’aire) →
  distance à la côte → relief (collines, ceintures montagneuses « ridged ») → volcans → océans →
  climat (latitude, altitude, circulation, proximité de la mer) → **hydrologie** (remplissage des
  dépressions *priority-flood*, directions d’écoulement, accumulation, lacs, creusement des lits) →
  biomes, couvert forestier, fertilité, biodiversité → masses continentales nommées → gisements →
  sites d’implantation notés.
- Le bruit 3D est échantillonné sur la sphère : aucune couture aux pôles ni au méridien.
- `World.elevationAt()` (bicubique + micro-relief procédural) est **la** source d’altitude, partagée par
  le maillage, le placement des arbres et des bâtiments, la caméra et le picking.

## Le rendu

- **Terrain** : 6 faces de cube projetées sur la sphère, subdivisées en quadtree (jusqu’au niveau 7,
  ≈ 1,2 m entre sommets). Sélection par distance, culling par frustum et par horizon, jupes anti-fissures,
  construction des parcelles étalée sur plusieurs images (budget en ms), libération des sous-arbres inactifs.
- **Matériaux** : `MeshStandardMaterial` étendu (`shared.ts → patchMaterial`) pour garder l’éclairage et
  les ombres de Three.js tout en ajoutant : couleur du sol calculée par pixel depuis température,
  humidité, forêt, pente, altitude et saison ; teinte du soleil selon l’heure locale ; ambiance de ciel ;
  ombres des nuages ; calque de l’Atlas.
- **Atmosphère** : post-traitement avec profondeur (diffusion Rayleigh + Mie intégrée le long du rayon).
  Une seule intégrale produit ciel bleu, crépuscules, limbe orbital et perspective aérienne.
  Licence artistique assumée : la brume est atténuée sur les surfaces proches pour garder la lisibilité
  d’une planète miniature.
- **Végétation** : arbres procéduraux (5 essences) en `InstancedMesh` par parcelle de niveau 4, semés de
  façon déterministe d’après le champ de couvert forestier ; au-delà, le shader du sol prend le relais.
- **Bâtiments** : un `InstancedMesh` par type, fenêtres émissives la nuit.

## Performance

Trois paliers de qualité (`render/quality.ts`) règlent résolution, anticrénelage, ombres, bloom, pas
d’intégration de l’atmosphère, densité des forêts, finesse du terrain et variantes de shaders
(`EPOCH_LOW`). Un gouverneur mesure les images réelles et abaisse la résolution puis le palier ; la
boucle de jeu (`game.ts`) cadence l’affichage (60 images/s en interaction, 30 au repos, arrêt en
arrière-plan). La génération du monde s’exécute dans un Web Worker. Diagnostic en jeu : FPS et cible,
palier, résolution dynamique, appels de dessin, triangles, parcelles, arbres.

## Sauvegardes

Format versionné (`SAVE_VERSION`). Le monde étant entièrement déterminé par sa graine, une sauvegarde
contient la graine, la somme de contrôle du monde (détection d’une dérive du générateur), la date
historique, la vitesse et la caméra. Les phases suivantes y ajouteront individus, familles, villes,
civilisations et événements. Sauvegarde automatique toutes les 30 s, à la fermeture et à la mise en
arrière-plan ; 3 emplacements manuels ; export/import JSON.

## Limites connues (phase 1)

- Le déterminisme est garanti sur un même moteur JavaScript ; `Math.sin/pow/exp` peuvent différer au
  dernier bit entre moteurs. Si l’échange de graines entre navigateurs devient un objectif, il faudra
  des versions logicielles de ces fonctions.
- Rivières et lacs sont peints sur le terrain creusé (pas de géométrie d’eau dédiée).
- Les hameaux fondateurs sont posés par le moteur pour valider la chaîne de construction ; dès la
  phase 3 ce sont les habitants qui décideront quoi bâtir.
- WebGL2 uniquement pour l’instant ; l’architecture des matériaux est isolée dans `render/` pour une
  future voie WebGPU.
- Les performances réelles sur téléphone restent à mesurer (voir MOBILE.md).
