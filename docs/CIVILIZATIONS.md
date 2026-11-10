# Civilisations, pouvoir, culture, croyances et savoir (phase 4)

Code : `src/sim/civilization.ts`, `src/sim/tech.ts`. Comme le reste de la simulation, tout est
déterministe, sauvegardé et exécuté une fois par jour simulé pour chaque peuple.

## Peuples

Chaque communauté fondatrice forme un **peuple** : un nom, une couleur (toits, tuniques, frontières),
une capitale, des terres, un dirigeant, un régime, une culture, des croyances et un savoir.
Un établissement habité qui n’appartient à personne fonde son propre peuple ; un peuple dont les
terres se vident **s’éteint** et reste dans l’histoire.

## Dirigeants et dynasties

- Le dirigeant est **un habitant réel** : il a une famille, des besoins, un foyer, il vieillit et meurt.
  Gouverner est son métier (il siège à la grande maison ou au temple).
- **Chefferie** : à la mort du chef, le peuple choisit le plus populaire (ambition, sociabilité,
  intelligence, éloquence, nombre d’amis). Si le défunt était ambitieux et respecté, sa maison impose
  son aîné : le régime devient une **monarchie héréditaire**.
- **Monarchie** : l’aîné adulte hérite. Sans héritier, un peuple qui connaît l’écriture confie le
  pouvoir à un **conseil des sages** (réélection tous les huit ans) ; sinon retour à la chefferie.
- Chaque règne est consigné (qui, de quand à quand, par quelle voie) dans la **maison régnante** ;
  un changement de famille ouvre une nouvelle maison.
- **Légitimité** : elle suit le sort du peuple (faim, famine), l’habileté du dirigeant, la ferveur
  partagée et l’ancienneté de la maison. Trop basse, elle expose à un **coup de force** — ou à une
  **révolte** si le peuple a faim — mené par l’habitant le plus ambitieux et le plus agressif.

## Culture

Quatre axes (martiale, solidaire, marchande, savante) tirés du tempérament des fondateurs, qui
dérivent lentement avec la population. Effets réels : les enfants sont **élevés dans ces valeurs**
(leurs traits s’en rapprochent), une culture savante entretient plus de savants, une tradition
donne lieu chaque année à une **grande fête** payée par le grenier (liens sociaux, légitimité,
ferveur) — annulée les années de disette.

## Croyances

Une croyance **naît** lorsqu’un habitant curieux et charismatique met des mots sur ce que son peuple
vénère ; son objet dépend du lieu réel (mer, rivière, forêt, montagne, ancêtres, soleil…). Elle se
**transmet** par la famille et les amitiés, donne lieu à des prières au temple (liens, sécurité),
se **divise** quand une grande communauté est agitée (un dissident emmène ses proches) et
**s’éteint** quand plus personne ne la suit. Les interventions divines de la phase 6 agiront sur la ferveur.

## Savoir

17 technologies en 10 domaines (`tech.ts`). Les points viennent des **savants** (métier), d’une
curiosité diffuse de tout le peuple et des **contacts** : un marchand revenant d’un peuple qui
connaît la technologie étudiée fait avancer la recherche. Le dirigeant oriente l’étude selon ce qui
manque à son peuple (et selon sa curiosité).

Chaque technologie modifie des grandeurs utilisées par la simulation : rendement des fermes, pêche,
extraction, pertes des greniers, efficacité et usure des outils, durée des chantiers, capacité des
marchands, mortalité des anciens, sévérité des mauvaises récoltes, traversée des mers.

## Colonisation

Un établissement prospère ou à l’étroit envoie quelques jeunes foyers vers la meilleure terre vide à
portée (sol, eau douce, logis abandonnés ; au-delà des mers seulement avec la voile et un ponton).
Les colons **voyagent physiquement**, emportent vivres, bois, pierre et une part de la caisse,
campent s’il n’y a pas de toit, puis bâtissent. La terre rejoint leur peuple.

## Histoire et archives

Tous les faits sont enregistrés (naissances, unions, morts, chantiers, récoltes, famines, commerce,
règnes, coups de force, changements de régime, découvertes, croyances, schismes, colonies, fêtes).
Le panneau Histoire les présente par catégorie ; chaque nom ouvre la fiche de la personne, **vivante
ou morte**. La recherche d’archives retrouve quiconque a vécu.

## Cartes

L’Atlas gagne trois cartes peintes d’après la simulation : **Frontières** (zones d’influence des
établissements, aux couleurs des peuples), **Population** et **Religions**.

## Limites connues

- Pas encore de diplomatie ni de guerre : les peuples coexistent et commercent (phase 5).
- Les frontières sont des zones d’influence circulaires autour des établissements.
- Le journal garde les 4 000 faits les plus récents (les faits mineurs les plus anciens sont oubliés
  en premier) ; les défunts, eux, sont tous conservés.
