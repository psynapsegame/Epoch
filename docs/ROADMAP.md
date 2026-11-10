# Feuille de route

| Phase | Contenu | État |
| --- | --- | --- |
| 1 — Le socle visuel | Planète procédurale, caméra orbite ↔ sol, jour/nuit, saisons, terrain, premiers bâtiments, interface de base, sauvegardes | **Livrée** |
| 1 bis — Virage mobile | Gestes tactiles, interface smartphone paysage, paliers de qualité et gouverneur adaptatif, cadence économe, PWA hors ligne, projets Capacitor iOS/Android, miroir natif des sauvegardes | **Livrée** (à valider sur téléphones réels) |
| 2 — Les premiers habitants | 100 individus autonomes (identité, famille, personnalité, besoins, souvenirs), Utility AI, trajets A*, simulation déterministe dans un Web Worker, rendu instancié, sélection au toucher, fiche d’individu, panneau Population, sauvegarde de la société | **Livrée** |
| 3 — La civilisation | 10 métiers réels, 8 ressources, stocks, prix et monnaie conservée, commerce entre établissements, chantiers décidés et bâtis par les habitants, unions, naissances, vieillesse, foyers, journal des événements, simulation agrégée aux grandes vitesses, panneau Économie | **Livrée** |
| 4 — Le monde historique | Peuples, dirigeants réels, successions, dynasties, coups de force, régimes, cultures transmises, croyances (naissance, diffusion, schisme, extinction), 17 technologies aux effets réels, colonisation, journal historique, archives consultables, cartes politiques | **Livrée** |
| 5 — Les conflits | Relations entre peuples, alliances, causes de guerre, soldats et levées, armées en marche, sièges, batailles par duels, conquêtes et pillage, traités, occupations, soulèvements et sécessions, carte des guerres | **Livrée** |
| 6 — Les pouvoirs divins | 14 pouvoirs aux effets réels et persistants (bienfaits, fléaux, remodelage de la planète), ferveur comme ressource, réactions des peuples selon leurs croyances, modifications du monde sauvegardées et rejouées | **Livrée** |
| 7 — Les chroniques | Événements identifiés, annales chiffrées exactes, annales du monde et chroniques des peuples où chaque phrase cite ses sources, récits de vie, arbres généalogiques, export des récits | **Livrée** |
| 8 — Polissage | Passage à l’échelle de la simulation (index par bourg, vie sociale échantillonnée, état transmis en texte), saut dans le temps « + N ans », bâtiments dessinés par bourg, fumée des foyers habités, carte des routes commerciales tirée des échanges réels, coût de la simulation dans le diagnostic | **Livrée en partie** — voir ci-dessous |

Règle : on ne passe pas à la phase suivante si le socle précédent est cassé (tests + vérification en navigateur).

## Ce qui reste hors de portée ou non fait

Dit sans détour, par rapport au cahier des charges d’origine :

- **Non vérifié** : fluidité sur téléphones réels, compilation des applications iOS / Android,
  populations au-delà de 3 630 habitants (voir [PERFORMANCE.md](PERFORMANCE.md)).
- **Non réalisé** : routes, ponts, murailles et châteaux bâtis par les habitants ; navires visibles
  (le commerce maritime existe dans la simulation, pas à l’image) ; faune ; voie WebGPU ;
  enrichissement des chroniques par un modèle de langage (point d’extension documenté, non branché).
- **Rarement observé** : guerres et coups de force spontanés (les mécanismes sont testés en les
  provoquant ; ils surviennent d’eux-mêmes sur des durées longues).
