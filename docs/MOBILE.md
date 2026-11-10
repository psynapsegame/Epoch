# EPOCH sur mobile

EPOCH est un jeu **mobile d’abord** : iPhone et Android, paysage, tactile, hors ligne. Le même code
tourne dans trois enveloppes :

| Enveloppe | Usage | Installation |
| --- | --- | --- |
| Application native **Android** (Capacitor) | Distribution Play Store / APK | `npm run android` puis Android Studio |
| Application native **iOS** (Capacitor) | Distribution App Store / TestFlight | `npm run ios` puis Xcode (macOS requis) |
| **PWA** (web installable, hors ligne) | Test immédiat sur un vrai téléphone, sans store | « Ajouter à l’écran d’accueil » |

## Choix technologiques

- **Three.js + WebGL2** : conservé. WebGL2 est disponible dans WKWebView (iOS 15+) et Android WebView.
- **WebGPU** : écarté pour l’instant. Il imposerait de réécrire tous les shaders (TSL / WGSL) alors que sa
  disponibilité dans les WebView mobiles reste partielle. Les matériaux sont isolés dans `src/render/`
  pour permettre une voie WebGPU en phase 8.
- **Capacitor 8** : enveloppe native, accès fichiers (miroir des sauvegardes), feuille de partage,
  cycle de vie de l’application, plein écran.
- **TypeScript + Vite** : conservés (build unique `dist/`, copié dans les projets natifs par `cap sync`).

## Construire les applications

```bash
npm install
npm run mobile:sync      # build web + copie dans android/ et ios/
npm run android          # ouvre Android Studio (SDK Android requis)
npm run ios              # ouvre Xcode (macOS + CocoaPods/SPM requis)
```

Tester sur téléphone sans build natif : `npm run dev:host`, puis ouvrir l’adresse réseau affichée
(même Wi-Fi). Pour la PWA hors ligne : `npm run build && npm run preview -- --host` (le service worker
exige HTTPS ou localhost ; sur un réseau local, utiliser un tunnel HTTPS).

Identifiant d’application : `com.psynapse.epoch` (`capacitor.config.ts`). Icône source 1024 px :
`resources/icon-1024.png`.

Orientation : paysage imposé (`AndroidManifest.xml` → `sensorLandscape`, `Info.plist` → paysage gauche/droite,
manifeste PWA → `landscape`). En portrait dans un navigateur, un écran invite à tourner l’appareil.

## Commandes tactiles

| Geste | Effet |
| --- | --- |
| Glisser un doigt | Parcourir le monde |
| Pincer / écarter deux doigts | Zoom continu, de l’orbite au sol |
| Tourner deux doigts | Pivoter la caméra (le monde suit les doigts) |
| Glisser deux doigts ensemble vers le haut / le bas | Incliner vers l’horizon / vers le sol |
| Toucher | Examiner une terre, un bâtiment (et les habitants dès la phase 2) |

Souris et clavier restent pris en charge (développement, tablettes avec clavier).

## Interface

- Cibles tactiles ≥ 44 px, textes agrandis, aucune information accessible uniquement au survol.
- Paysage compact (hauteur < 560 px) : barre d’état fine en haut, navigation en dock en bas à gauche,
  vues en bas à droite, panneaux en volets latéraux défilables, tutoriel une étape à la fois.
- Zones sûres (`env(safe-area-inset-*)`) : rien sous l’encoche ni sous l’indicateur d’accueil.
- Sur les paliers bas et moyen, les panneaux sont opaques : le flou d’arrière-plan coûte cher sur GPU mobile.

## Performances, chaleur et batterie

Tout est piloté par `src/render/quality.ts` (logique pure, testée).

**Paliers de qualité** — choisis au démarrage selon l’appareil (mémoire, cœurs, tactile), modifiables
dans Monde → Affichage et énergie :

| | Basse | Moyenne (défaut mobile) | Haute (défaut bureau) |
| --- | --- | --- | --- |
| Densité de pixels max. | 1,25 | 1,75 | 2 |
| Anticrénelage MSAA | — | — | ×4 |
| Ombres | — | 1024, nettes | 2048, douces |
| Bloom | — | oui | oui |
| Atmosphère (pas de rayon) | 6 / 2 | 8 / 3 | 10 / 4 |
| Densité des forêts | 31 % | 60 % | 100 % |
| Finesse du terrain | réduite | moyenne | maximale |
| Shaders | simplifiés | complets | complets |

**Gouverneur adaptatif** — mesure le temps réel entre images pendant l’interaction. Si le budget est
dépassé de 30 % : résolution dynamique 100 → 85 → 72 → 60 %, puis (en mode Auto) palier inférieur.
Après une longue période stable il retente une fois un cran plus net, et n’insiste pas en cas d’échec.
Les pics de chargement (construction du terrain, retour d’arrière-plan) sont ignorés.

**Cadence d’images** — 60 images/s pendant qu’on touche l’écran ou que la caméra voyage, 30 au repos ;
mode « Économie d’énergie » : 30 / 20. Les écrans 120 Hz sont plafonnés à 60. En arrière-plan, plus
rien n’est dessiné ni simulé, et la partie est sauvegardée.

**Mémoire** — monde ≈ 65 Mo de tableaux typés + ≈ 35 Mo de textures ; le terrain libère les parcelles
inactives ; la génération (pic ≈ 150 Mo) se fait dans un Web Worker qui est détruit ensuite.

**Simulation indépendante du rendu** — la simulation avance en temps simulé, pas en images : baisser la
cadence ou la résolution ne change rien à l’histoire du monde. Les phases suivantes placeront les
habitants dans un Web Worker avec fréquence de mise à jour par distance et agrégation des habitants
éloignés ; seuls les individus proches de la caméra seront rendus (instanciés).

## Sauvegardes sur mobile

- IndexedDB (toutes plateformes) + demande de stockage persistant (`navigator.storage.persist()`),
  indispensable sur iOS où le stockage web peut être purgé.
- Applications natives : chaque sauvegarde est doublée d’un fichier dans le dossier privé de
  l’application ; au démarrage, les emplacements manquants sont restaurés depuis ce miroir.
- Sauvegarde automatique toutes les 30 s et à chaque passage en arrière-plan.
- Export : feuille de partage native / Web Share ; import : sélecteur de fichiers.

## Ce qui n’a pas pu être vérifié dans l’environnement de développement

Cet environnement n’a ni téléphone, ni GPU, ni Xcode, ni SDK Android. Ont été vérifiés : la mise en
page et les gestes en émulation tactile (Chromium), le build web/PWA, la génération et la
synchronisation des projets natifs. **Restent à faire sur matériel réel** : compilation Android Studio /
Xcode, mesure des performances et de la chauffe sur des téléphones de gammes différentes, réglage fin
des paliers d’après ces mesures.
