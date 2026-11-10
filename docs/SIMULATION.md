# La simulation des habitants (phase 2)

## Vue d’ensemble

```
        thread principal                              Web Worker
┌──────────────────────────────┐         ┌──────────────────────────────────┐
│ Game  ── SimClient ──────────┼ rate ──▶│ sim.worker.ts                    │
│  │        ▲  ▲  ▲            │ watch   │   └─ Simulation (pure, déterministe)
│  │        │  │  └ état complet (10 s)  │        pas fixe : 60 s simulées  │
│  │        │  └─ fiche d’un individu    │        Utility AI · A* · besoins │
│  ▼        └─ instantané (positions)    │                                  │
│ PeopleLayer (rendu instancié)│◀────────┤                                  │
└──────────────────────────────┘         └──────────────────────────────────┘
```

- `src/sim/simulation.ts` est **pur** : ni DOM, ni Three.js, ni horloge murale. Il tourne tel quel
  dans Node pour les tests et dans le worker en jeu.
- Le **pas de temps est fixe** (60 secondes simulées). La vitesse choisie par le joueur ne fait que
  changer le nombre de pas exécutés par seconde : l’histoire du monde ne dépend ni de la vitesse, ni
  de la cadence d’affichage, ni de la puissance du téléphone. Si l’appareil ne suit pas, le temps
  s’écoule simplement moins vite (« simulation ralentie » dans le diagnostic).
- Le worker **possède le temps**. Le rendu lit des instantanés et lisse les positions entre deux pas.
- L’aléa passe par un flux `Rng` dont l’état fait partie de la sauvegarde : reprendre une partie
  donne exactement la même suite qu’une partie ininterrompue (testé).

## Échelle de temps

À ×1 une journée dure 8 minutes réelles. La vitesse de marche (0,022 m par seconde simulée, soit
≈ 4 m/s à l’écran à ×1) est choisie pour que les déplacements soient lisibles : c’est une licence de
jeu assumée, le calendrier avance plus vite que les corps.

| Vitesse | Une journée dure | |
| --- | --- | --- |
| ×1 | 8 min | observation |
| ×4 | 2 min | |
| ×24 | 20 s | le soleil suit encore exactement l’heure simulée |
| ×240 | 2 s | le ciel ne fait plus que dériver |
| ×2400 | 0,2 s | une année en 72 s |

L’heure locale (`clock.ts → localHour`) est l’unique source de vérité, partagée par la simulation
(sommeil, tombée de la nuit) et par le rendu (position du soleil).

## Les individus

Chaque habitant (`types.ts → Person`) est une donnée persistante : identité, apparence, 9 traits de
personnalité, 6 besoins, savoir-faire, santé, foyer, conjoint, parents, enfants, liens d’affinité,
souvenirs datés, et son état courant (position, action, trajet).

La population fondatrice (`populate.ts`) est composée de familles logées dans les habitations des
hameaux : couples avec ou sans enfants, parents seuls, anciens, célibataires. Les enfants héritent
d’une part du tempérament et de l’apparence de leurs parents.

## Décisions : Utility AI

À chaque fin d’action (et en cas de besoin critique), `Simulation.utilities()` note chaque action
possible ; la meilleure action *réalisable* est entreprise.

| Action | Ce qui fait monter son score |
| --- | --- |
| Manger | faim (au carré), heures de repas ; impossible si le garde-manger est vide |
| Boire | soif (au carré) |
| Dormir | fatigue, nuit |
| Cueillir et chasser | garde-manger sous le niveau jugé sûr (**prudence**), **ambition**, faim sans réserves |
| Discuter | manque de liens × **sociabilité** ; le partenaire est choisi selon les affinités × **loyauté** |
| Explorer | **curiosité** × **courage**, seulement quand le corps va bien |
| Se reposer au foyer | insécurité × **prudence**, froid, nuit |
| Jouer (enfants) | **curiosité**, manque de compagnie |

Autres effets réels de la personnalité : l’**altruisme** fait porter des vivres aux foyers démunis,
l’**agressivité** provoque des brouilles, l’**intelligence** accélère l’apprentissage, le **courage**
agrandit le rayon de cueillette et d’exploration. Les tests vérifient statistiquement que les plus
sociables discutent davantage et que les plus curieux explorent davantage.

## Besoins et conséquences

Nourriture, eau, sommeil, sécurité, logement, liens sociaux évoluent en temps simulé. Une cueillette
rapporte des repas selon la richesse réelle du terrain (fertilité, forêt, rivage), la saison et le
savoir-faire ; ils sont **portés** jusqu’au garde-manger du foyer. Sans nourriture ou sans eau la
santé décline jusqu’à la mort ; les proches gardent le souvenir du deuil et le défunt rejoint les
archives avec toute sa chronologie.

## Déplacements

Chaque hameau possède une carte locale (`sites.ts`, cellules de 3 m, 450 m de côté) tirée du terrain
réel : zones praticables (ni eau, ni pente forte, ni emprise de bâtiment), richesse de cueillette,
points d’eau douce. Les trajets sont calculés par A* puis lissés par lignes de vue
(`pathfinding.ts`) ; les trajets en cours font partie de la sauvegarde.

## Rendu et sélection

`render/peopleLayer.ts` dessine les habitants en un seul `InstancedMesh` (≈ 150 triangles chacun,
marche et gestes animés dans le vertex shader). Le nombre dessiné est plafonné par palier de qualité
(150 / 300 / 600) ; **tous** restent simulés. Les habitants à l’intérieur d’un bâtiment ne sont pas
dessinés. La sélection se fait en espace écran avec un rayon généreux au doigt.

## Vers des milliers d’habitants

Mesure actuelle (Node, un cœur) : ≈ 10 000 pas/s pour 100 habitants, soit ≈ 1 µs par habitant et par
pas. Pour 5 000–10 000 habitants, les phases suivantes ajouteront : mise à jour échelonnée des
besoins, agrégation des habitants loin de la caméra aux vitesses élevées, instantanés limités au
voisinage de la caméra.

## Limites connues

- Les habitants restent dans le périmètre de leur hameau (≈ 225 m) : les voyages entre hameaux
  arrivent avec le commerce et l’exploration (phases 3–4).
- Pas encore de naissances ni de vieillissement mortel : le cycle des générations est la phase 4.
- Le don de vivres entre foyers voisins est instantané (pas de trajet dédié).
- Métiers et richesse : tout adulte vit de cueillette ; l’économie est la phase 3.
