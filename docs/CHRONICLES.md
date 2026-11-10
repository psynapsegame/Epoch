# Chroniques, annales et généalogie (phase 7)

Code : `src/sim/chronicle.ts` (récits), `src/sim/simulation.ts` (`record`, `tree`, `search`),
`src/sim/economy.ts` (clôture des annales), `src/ui/app.ts` (section Chroniques).

## La règle : rien n’est inventé

Le générateur ne dispose que de deux matières premières, toutes deux produites par la simulation :

1. **Le journal des événements** (`SimState.events`) — chaque fait reçoit un identifiant unique
   croissant et l’indication du peuple concerné au moment où il s’est produit.
2. **Les annales** (`SimState.annals`) — à chaque nouvel an, chaque établissement habité clôt son
   année : naissances, décès par cause (vieillesse, faim ou soif, combat, fléau), unions, bâtiments
   achevés, population, récolte. Ces chiffres exacts sont conservés pour toujours, même quand les
   événements mineurs les plus anciens ont été oubliés du journal.

Chaque phrase d’un récit (`Sentence`) porte la liste des identifiants d’événements et de relevés
annuels dont elle est tirée. Une phrase qui rapporte un événement n’en est qu’une reformulation ;
une phrase chiffrée somme des relevés annuels. Les tests vérifient que :

- aucune phrase n’existe sans source ;
- toute source citée existe dans l’état de la simulation ;
- une phrase ne nomme que des personnes présentes dans ses événements sources ;
- les chiffres cités sont exactement ceux des annales citées ;
- les annales concordent avec les événements détaillés de la même année ;
- le récit est déterministe.

Dans l’interface, **toucher une phrase** affiche ses sources : les événements enregistrés (dont les
noms mènent aux fiches, y compris celles des défunts) et les relevés annuels chiffrés.

## Les récits

- **Annales du monde** : un chapitre par décennie, les grands faits de tous les peuples (naissances
  et extinctions de peuples, règnes, coups de force, régimes, découvertes, croyances et schismes,
  colonies, guerres, sièges, batailles, conquêtes, sécessions, famines, interventions divines et
  leur interprétation), puis le bilan démographique.
- **Chronique d’un peuple** : un chapitre par règne, de l’avènement à la fin du règne, avec ce qui a
  concerné ce peuple (y compris les guerres qu’on lui a faites) et le bilan chiffré de ces années.
- **Récit de vie** (fiche d’un habitant) : chaque proposition reprend un fait de sa fiche (naissance,
  parents, union, enfants, hauts faits datés, amitiés, deuils, mort).
- **Export** du récit en texte (feuille de partage sur mobile).

Le style vient de gabarits de phrases variés, choisis de façon déterministe ; les liaisons
(« l’année suivante », « la même année ») sont calculées d’après les dates réelles.

## Généalogie et archives

- **Arbre généalogique** de toute personne, vivante ou morte : grands-parents, parents, conjoint,
  frères et sœurs, enfants, petits-enfants. Toucher un nom recentre l’arbre.
- **Archives** (section Histoire) : recherche par nom parmi tous ceux qui ont vécu.
- Tous les défunts sont conservés avec leur chronologie complète.

## Enrichissement par un modèle de langage

Non branché. Le cahier des charges le prévoit comme optionnel ; le jeu fonctionne entièrement hors
ligne avec le générateur local. Le point d’extension est net : un enrichisseur recevrait la liste des
`Sentence` (texte + sources) d’un chapitre et devrait rendre un texte dont chaque phrase reste
rattachée aux mêmes sources ; l’affichage des sources ne changerait pas. Il faudrait alors vérifier
automatiquement qu’aucun nom, lieu ou nombre absent des sources n’apparaît dans le texte enrichi.

## Limites connues

- Le journal détaillé garde les 4 000 faits les plus récents ; les naissances, unions, ventes,
  fêtes et chantiers les plus anciens sont oubliés en premier. Les chroniques de périodes très
  anciennes s’appuient alors davantage sur les annales chiffrées.
- Le style reste sobre et répétitif sur les longues périodes (mêmes tournures).
- Un chapitre est limité à 60–70 faits notables.
