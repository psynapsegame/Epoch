# Pouvoirs divins (phase 6)

Code : `src/sim/divine.ts` (effets sur la société, réactions des peuples), `src/world/edits.ts`
(modifications durables de la planète), `src/game.ts → divine()` (enchaînement), `src/render/divineFx.ts`
(effets visuels, purement décoratifs).

Le joueur choisit un pouvoir dans la section **Divinité**, puis touche le monde. L’intervention est
une *entrée* de la simulation : elle est appliquée dans le fil de simulation, consignée dans le
journal, et tout ce qu’elle change fait partie de la sauvegarde.

## Ferveur

Chaque pouvoir coûte de la ferveur (0–100). Elle se reforme chaque jour, d’autant plus vite que les
habitants croient avec ferveur : un monde pieux donne plus de prise à sa divinité.

## Pouvoirs

| Pouvoir | Coût | Effet réel |
| --- | --- | --- |
| Bénédiction | 20 | Guérit et rassasie les habitants ; un an de naissances plus nombreuses et de morts de vieillesse retardées |
| Récolte miraculeuse / maudite | 15 | Facteur de récolte à 150 % ou 30 % jusqu’au printemps |
| Envoyer du gibier | 10 | Trois ans de chasse abondante (cueillette qui se reforme 1,8× plus vite) |
| Protéger un peuple | 30 | Dix ans à l’abri des fléaux divins ; défenseurs 2,5× plus redoutables |
| Susciter un être d’exception | 35 | Un jeune adulte reçoit intelligence, courage, ambition, charisme et savoir-faire hors du commun |
| Faire naître une forêt | 15 | Couvert forestier durable : arbres visibles, bois, gibier |
| Créer un gisement | 20 | Filon de fer inscrit dans le sous-sol : une mine peut l’exploiter |
| Élever une montagne | 30 | Relief durable ; l’altitude refroidit le lieu (neiges), les pentes deviennent impraticables |
| Creuser une vallée | 20 | Terrain abaissé et adouci, sols plus fertiles |
| Tempête | 15 | Dix jours presque sans pêche ni cueillette ; chantiers endommagés |
| Sécheresse | 25 | Deux ans de récoltes à 40 % et de cueillette appauvrie |
| Incendie | 25 | Forêt brûlée (cendres fertiles), maisons de bois détruites ou à réparer, réserves perdues, victimes |
| Météorite | 40 | Cratère durable ; bâtiments rasés et morts au point d’impact, blessés autour |

Les pouvoirs qui remodèlent la planète (`WorldEdit`) modifient la grille du monde ; le terrain,
les textures, les arbres et la carte locale des établissements voisins sont reconstruits à chaud.
Une sauvegarde contient la liste de ces modifications : au chargement, le monde est régénéré depuis
sa graine puis les modifications sont rejouées dans l’ordre, à l’identique.

## Ce qu’en pensent les peuples

Tout habitant témoin garde le souvenir du prodige. Le peuple l’interprète :

- **Sans croyance** : le témoin le plus inspiré peut fonder une croyance née du phénomène
  (la météorite donne un culte des étoiles, l’incendie un culte de la flamme…).
- **Bienfait** : la ferveur monte (davantage si le prodige relève de ce que le peuple vénère) et
  le dirigeant y gagne en légitimité.
- **Fléau conforme à la croyance** (« la colère de notre dieu ») : la peur resserre les fidèles.
- **Fléau inexplicable** : le doute s’installe, des fidèles abandonnent leur foi, le dirigeant est blâmé.

Chaque interprétation est consignée dans l’Histoire.

## Limites connues

- Les effets visuels sont simples (colonne de lumière, boule de feu, flammes, onde de poussière).
- Montagnes et vallées ne déplacent pas les rivières ; une rivière ensevelie disparaît à cet endroit.
- Un pouvoir « terrain » ne peut pas être lancé sur la mer.
- Le gisement créé est toujours du fer.
