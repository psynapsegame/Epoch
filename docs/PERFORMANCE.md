# Performances et passage à l’échelle (phase 8)

Ce document donne des **mesures réelles** et dit clairement ce qui n’a pas pu être mesuré.

## Ce qui a été fait

| Sujet | Avant | Après |
| --- | --- | --- |
| Recherche d’un interlocuteur (vie sociale) | parcours de tous les habitants du monde | 40 voisins tirés au sort dans le bourg + les proches (index `residentsOf`) |
| Recensements quotidiens (économie, métiers, logement) | filtrage de toute la population par bourg | index des résidents par bourg, recalculé seulement quand quelqu’un naît, meurt ou déménage |
| État envoyé à l’écran pour les sauvegardes | objet complet cloné toutes les 10 s sur le fil d’affichage | **texte JSON** produit dans le worker, stocké tel quel, relu seulement au chargement ou à l’export |
| Bâtiments | un seul lot pour toute la planète, toujours dessiné | un lot par bourg et par type : seuls les bourgs à moins de 3,4 km et dans le champ sont dessinés |
| Noms de famille | boucle sans fin au-delà de 480 foyers | noms composés quand le répertoire est épuisé |

## Mesures de la simulation

Machine de développement (serveur x86, un cœur, Node 22), simulation seule, sans affichage :

| Population | Pas de simulation | Coût par pas | Un jour simulé | Une année simulée |
| --- | --- | --- | --- | --- |
| 1 470 habitants | 30 min (mode saut) | 2,3 – 4,6 ms | 0,11 – 0,22 s | ≈ 1 min |
| 2 200 habitants | 6 min (×240) | 2,4 – 3,3 ms | 0,6 – 0,8 s | — |
| 3 630 habitants | 30 min (mode saut) | 6,3 – 7,6 ms | 0,30 – 0,36 s | ≈ 2 min |

Autres coûts à 3 630 habitants : instantané pour l’affichage 4 ms, registre 2,3 ms, économie 2,3 ms,
vue du monde 2 ms, sérialisation 77 ms (dans le worker), sauvegarde ≈ 5 Mo.

Conséquences honnêtes :

- La vitesse **×2400** demande un demi-jour simulé par seconde : tenable sur cette machine jusqu’à
  environ 3 500 habitants. Un téléphone est typiquement 2 à 4 fois plus lent ; au-delà, la simulation
  prend du retard et l’interface l’indique (« simulation ralentie » dans le diagnostic). Rien n’est
  sauté : le temps avance simplement moins vite que demandé.
- **Traverser le temps** (« + 1 / 10 / 50 ans ») simule réellement chaque demi-heure de chaque
  habitant. Avec une centaine d’habitants, un an prend quelques secondes ; avec plusieurs milliers,
  compter une à deux minutes par an sur un ordinateur, davantage sur téléphone. Le bouton « Arrêter
  ici » rend la main à tout moment.
- **5 000 à 10 000 individus** : la simulation les supporte structurellement (aucun algorithme
  quadratique connu ne reste dans le pas de temps), mais **cela n’a pas été mesuré** au-delà de
  3 630 habitants, et jamais sur un téléphone.

## Affichage

- Habitants : budget d’instances par palier de qualité (150 / 300 / 600) ; les plus proches de la
  caméra sont dessinés, tous sont simulés.
- Bâtiments : dessinés par bourg ; le diagnostic affiche le nombre réellement dessiné.
- Fumée des foyers : 5 points par cheminée, animés dans le shader, uniquement pour les maisons
  habitées et les ateliers où quelqu’un travaille, et seulement à moins de 1,5 km.
- Le diagnostic (Monde → Diagnostic) affiche aussi le coût d’un pas de simulation et sa finesse.

## Ce qui n’a pas été vérifié

- Aucun essai sur un vrai téléphone ni sur un vrai processeur graphique : l’environnement de
  développement n’a qu’un rendu logiciel (1 à 10 images par seconde), inutilisable pour mesurer la
  fluidité. Les paliers de qualité et le gouverneur adaptatif sont testés unitairement, pas sur appareil.
- Les applications natives iOS et Android n’ont jamais été compilées ici (ni Xcode ni SDK Android).
- La voie WebGPU reste une piste documentée dans `MOBILE.md`, non réalisée.
