# Routes et murailles

Les routes et les murailles sont de **vrais chantiers** : le bourg les décide, ses bâtisseurs y
passent des heures et y consomment des matériaux, et une fois l’ouvrage fait il change la vie des
habitants. Rien n’est dessiné qui n’ait été bâti : une route n’apparaît que jusqu’où les bâtisseurs
sont arrivés, une muraille pièce par pièce.

Code : `src/sim/infrastructure.ts` (décision, tracé, coût, effets), `src/render/infraLayer.ts`
(affichage), tests dans `tests/sim.test.ts` (« roads and walls »).

## Routes

| | Rue | Grand chemin |
| --- | --- | --- |
| Condition | bourg de 30 habitants, fondé depuis 120 jours | bourg de 60 habitants, toutes ses rues faites |
| Tracé | de la place (ou d’une rue finie) à la porte d’un bâtiment non desservi, par le chemin réellement praticable (A*) | de la place vers le voisin habité le plus proche par voie de terre, jusqu’au bord du terroir |
| Coût | 12 h + 0,4 h par mètre, 0,04 pierre par mètre | idem |
| Effet | marche **35 % plus rapide** sur les cellules de route | en plus : voyages des marchands vers ce voisin **25 % plus rapides** (50 % si les deux bourgs ont bâti leur moitié) |

Les bâtiments sont desservis dans l’ordre : entrepôt, marché, temple, ponton, atelier, mine, grange,
moulin, fermes, puis les maisons. Aucun bâtiment n’est ensuite construit en travers d’une route.
Un seul ouvrage public à la fois par bourg, avec douze jours de pause entre deux ; un bâtisseur sur
trois s’y consacre en priorité, les autres aux bâtiments, et un chantier à court de matériaux est
délaissé pour un autre.

## Murailles

- **Décision** : un bourg d’au moins 70 habitants qui a une raison de s’enfermer — son peuple a
  connu une guerre, un voisin lui est hostile (opinion < −0,15) ou il a déjà une tour de guet.
- **Tracé** : un anneau autour du cœur du bourg (rayon de 40 à 126 m, choisi pour heurter le moins
  de bâtiments). Il s’interrompt là où le terrain ferme déjà le passage (eau, falaise) et contre
  les bâtiments qu’il rencontre.
- **Portes** : une sur chaque route traversée, une vers chaque quart de l’horizon, et autant qu’il
  en faut pour qu’aucune porte de maison, aucun point d’eau ni aucun champ accessible auparavant ne
  soit coupé (vérifié par remplissage du terrain praticable avant d’ouvrir le chantier).
- **Matériau** : palissade de bois (1,5 bois et 2,6 h par pièce de 3 m), ou mur de pierre pour un
  peuple qui connaît la maçonnerie (1,6 pierre, 0,3 bois et 4,5 h par pièce).
- **Effets, une fois achevée seulement** : le sol sous la muraille n’est plus praticable — on entre
  et on sort par les portes ; la défense est multipliée par 1,3 (palissade) ou 1,6 (pierre) au
  combat ; une armée ennemie doit d’abord l’assiéger, comme pour une tour de guet.

## Dans l’interface

Le panneau Économie indique pour chaque bourg les mètres de route faits et l’état de sa muraille.
Les chantiers figurent au journal (« Chantier ouvert : route de 84 m », « Muraille achevée »), et
l’achèvement d’une muraille entre dans les chroniques.

## Limites

- Les marchands, colons et armées en voyage entre bourgs ne suivent pas le tracé des routes : leur
  trajet est une ligne droite accélérée par le grand chemin. Les murailles ne les arrêtent pas
  physiquement : elles comptent dans le siège et le combat.
- Pas de ponts : une route contourne l’eau ou n’est pas tracée. Les grands chemins s’arrêtent au
  bord du terroir du bourg (225 m) ; ils ne sont pas dessinés entre les bourgs.
- Une muraille n’est ni agrandie ni rebâtie en pierre plus tard, et les pouvoirs divins ne la
  détruisent pas.
- Aux très grandes vitesses (simulation agrégée), les trajets ne sont pas tracés : le bonus de
  route s’applique seulement quand la ligne droite passe sur une route.
- Vérifié en navigateur : rues tracées par les habitants en trois ans, palissade complète avec
  portes. **Non observé** : une muraille décidée spontanément (il faut 70 habitants et une menace ;
  le mécanisme est testé en le provoquant), le mur de pierre à l’écran, les grands chemins.
