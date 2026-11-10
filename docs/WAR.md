# Diplomatie, armées et guerres (phase 5)

Code : `src/sim/war.ts`. Les armées sont faites d’habitants réels : chaque mort au combat retire
quelqu’un de son foyer, de son métier, de sa famille, et entre aux archives.

## Relations entre peuples

Deux peuples se connaissent dès que leurs établissements sont à portée (5,2 km par terre ; par mer
seulement avec la voile et un ponton). Leur **opinion** (−100 à +100) dérive lentement vers ce que
leurs rapports justifient :

- **Ce qui rapproche** : le commerce des deux dernières années, une foi commune, des mœurs proches.
- **Ce qui oppose** (c’est aussi la *cause* retenue si la guerre éclate) : terres trop proches,
  rivalité de dirigeants agressifs et de cultures martiales, croyances différentes et ferventes,
  convoitise du fer et de l’or, crainte d’un voisin bien plus fort — plus le **ressentiment** des
  guerres passées, qui met dix ans à s’éteindre.

Une opinion haute peut mener à une **alliance** (l’allié entre en guerre aux côtés du peuple
attaqué) ; une alliance se rompt si l’entente retombe.

## Entrée en guerre

Un dirigeant belliqueux (agressif, ambitieux, de culture martiale) déclare la guerre à un peuple
qu’il méprise s’il s’estime plus fort et qu’aucun traité ne l’en empêche. La force d’un peuple =
adultes valides × esprit martial × technologies d’armement × outils disponibles.

## Soldats et armées

- **Soldat** est un métier : petit guet en temps de paix (tour de guet, cultures martiales), **levée**
  en temps de guerre (18 à 33 % des adultes). Les soldats patrouillent et s’exercent.
- Chaque camp lève une **armée** parmi les soldats de l’établissement le plus proche de l’ennemi ;
  elle **marche physiquement** jusqu’à la cible (visible dans le monde, avec lances et boucliers,
  et signalée par une étiquette).
- Une place dotée d’une tour de guet est d’abord **assiégée** six jours : ses habitants ne peuvent
  plus cueillir au loin ni commercer.
- **Bataille** : les défenseurs sont les soldats présents rejoints par les adultes les plus
  courageux. Toutes les vingt minutes simulées, des duels opposent attaquants et défenseurs ;
  l’issue dépend du savoir-faire aux armes, du courage, de l’âge, des technologies, des outils et de
  l’avantage du terrain (+15 %, +40 % derrière une tour). Le vaincu est blessé ou tué. Un camp
  réduit à moins de 45 % de ses effectifs rompt le combat.
- **Conquête** : si les attaquants l’emportent, l’établissement passe sous leur loi ; 30 % des stocks
  et la moitié de la caisse sont emportés. Le vaincu déplace sa capitale s’il lui reste des terres ;
  sinon son peuple s’éteint.

## Paix

La lassitude (morts rapportés à la population, durée, terres perdues) finit par imposer un
**traité** : vainqueur désigné d’après les conquêtes et les pertes, trêve de six ans, ressentiment
durable. Une guerre dont un belligérant disparaît s’achève d’elle-même.

## Occupations, soulèvements, sécessions

Chaque année, un établissement occupé peut se **soulever** et rejoindre son peuple d’origine (ou
fonder le sien si celui-ci n’existe plus) ; une colonie lointaine et peuplée, mal gouvernée, peut
**faire sécession**. La légitimité des dirigeants baisse en temps de guerre, avec les longs règnes
et au gré des querelles de chaque année : les coups de force et les révoltes de la phase 4 en
deviennent plus fréquents.

## Dans l’interface

- HUD : nombre de conflits en cours.
- Politique : relations (statut, opinion, tension dominante), forces en présence, guerres passées et
  en cours (cause, batailles, morts, terres prises, issue).
- Histoire : catégorie « Guerres ».
- Atlas : carte « Guerres » (peuples en guerre, terres occupées, places assiégées).
- Étiquettes des armées en campagne (toucher pour s’y rendre).

## Limites connues

- Pas encore de murailles ni de châteaux : la tour de guet tient lieu de fortification.
- Les armées marchent en ligne droite entre établissements voisins et n’attaquent que le plus proche.
- Pas de guerre civile à proprement parler : les crises internes prennent la forme de coups de
  force, de révoltes et de sécessions.
- Les guerres restent rares dans un monde où les peuples commercent et se ressemblent.
