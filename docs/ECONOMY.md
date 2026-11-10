# Économie, métiers, construction et générations (phase 3)

Tout ce qui suit vit dans la simulation déterministe (`src/sim/economy.ts`, `src/sim/simulation.ts`) :
rien n’est scénarisé, chaque chiffre affiché est un état réel.

## Ressources

Nourriture, bois, pierre, fer, charbon, or, outils, objets artisanaux. Chaque établissement possède un
stock commun (grenier/entrepôt), une caisse commune et des prix ; chaque foyer a un garde-manger et
une bourse.

- **Prix** : `prix = prix de base × (niveau visé / stock)^0,6`, borné entre 35 % et 400 %. Le niveau
  visé dépend de la population, des métiers présents et des chantiers en cours.
- **Monnaie conservée** : la caisse paie les producteurs (80 % du prix) et les bâtisseurs ; les foyers
  achètent leur nourriture au grenier ; une dîme et, à l’inverse, un partage de l’excédent de caisse
  maintiennent la circulation. Les tests vérifient que la masse monétaire totale ne varie pas.
- **Pertes** : le grenier perd 1,5 % de nourriture par jour.

## Métiers (fonctions réelles)

| Métier | Lieu | Produit | Dépend de |
| --- | --- | --- | --- |
| Cueilleur | terres sauvages | nourriture (garde-manger, excédent vendu) | richesse du terrain, saison, pression de cueillette |
| Agriculteur | ferme | nourriture | fertilité du sol sous la ferme, saison, récolte de l’année, moulin, outils |
| Éleveur | grange | nourriture | saison |
| Pêcheur | ponton | nourriture | — |
| Bûcheron | forêt | bois | densité des arbres, outils |
| Mineur | mine (ou ramassage sans mine) | pierre, fer, charbon, or | gisement réel de la carte, outils |
| Bâtisseur | chantier | avancement | matériaux en stock, outils |
| Forgeron | atelier | outils | **fer** + charbon (ou bois) — sans fer, pas d’outils |
| Artisan | atelier | objets | bois |
| Marchand | marché → voisin | échanges | écarts de prix entre établissements |

Chaque matin, le marché du travail (`assignJobs`) garde en poste ceux dont le métier est encore
nécessaire et attribue les postes ouverts, du plus urgent (prix élevé) au moins urgent, aux adultes
les plus aptes (savoir-faire + tempérament). Les producteurs travaillent d’autant plus que leur
produit est demandé : un grenier plein raccourcit les journées.

Les **outils** augmentent la productivité de 35 % et s’usent. Un établissement sans fer finit sans
outils — sauf si un marchand en rapporte.

## Commerce

Un marchand charge au dépôt l’excédent le plus rentable, **voyage physiquement** jusqu’à
l’établissement voisin (même terre, à moins de 3,6 km), vend, rachète si possible une cargaison de
retour, puis rentre régler la marchandise prise en consignation. Chaque vente est consignée au journal.

## Construction

Chaque jour la communauté décide du prochain chantier d’après sa situation réelle : logements
surpeuplés → maison ; pas d’entrepôt → entrepôt ; grenier bas et terres fertiles → ferme ; rivage →
ponton ; gisement à portée → mine ; puis atelier, grange, marché, moulin, temple, tour de guet.

L’emplacement est cherché sur la carte locale (sol praticable, dégagé, fertile pour une ferme, sur le
rivage pour un ponton, sur le filon pour une mine). Les bâtisseurs s’y rendent ; chaque quart de
travail convertit heures et **matériaux réellement en stock** en avancement. Sans matériaux, le
chantier s’arrête et la pénurie est consignée. À l’écran, le bâtiment s’élève depuis ses fondations
au rythme de l’avancement.

## Familles et générations

- **Unions** : deux adultes libres qui se sont rapprochés (affinité née de leurs conversations) et
  ne sont pas parents. Les célibataires recherchent la compagnie les uns des autres.
- **Naissances** : grossesse de 270 jours ; il faut une mère en bonne santé, nourrie, et de la place
  au foyer. L’enfant hérite d’une part du tempérament et de l’apparence de ses parents.
- **Foyers** : un couple logé chez des parents, un enfant devenu adulte ou une famille à l’étroit
  emménagent dès qu’un logis se libère ou qu’une maison est achevée.
- **Vieillesse** : la mortalité croît avec l’âge après 55 ans. Les orphelins rejoignent le foyer d’un
  proche ; un foyer sans héritier rend ses biens à la communauté.

## Pénuries et conséquences

- Mauvaise année (facteur de récolte tiré chaque printemps) → moins de nourriture des fermes.
- Cueillette excessive → la nature rend moins ; au-delà d’un hameau, il faut des fermes.
- Grenier et garde-manger vides plusieurs jours → **famine** consignée, puis morts de faim.
- Pas de fer → pas d’outils ; pas de pierre ou de bois → chantiers à l’arrêt.

## Simulation agrégée aux grandes vitesses

À ×24 et au-delà, plusieurs pas sont fusionnés (2, 6 puis 20 minutes simulées par pas) et, à partir de
×240, les trajets ne sont plus tracés pas à pas. Les individus, familles, métiers, stocks et événements
restent simulés un par un ; seule la finesse temporelle diminue. C’est ce qui permet d’avancer d’une
année en ≈ 72 s sur un téléphone.

## Limites connues

- Les trois hameaux sans fondateurs restent vides : la colonisation arrive avec les civilisations (phase 4).
- Pas encore de routes ni de murailles ; les forêts ne s’éclaircissent pas sous la hache.
- Les marchands voyagent en ligne droite entre établissements d’une même terre.
- Les décisions collectives (chantiers, métiers) sont prises par la communauté ; les dirigeants
  individuels arrivent en phase 4.
