# BTC Monitor — Bitcoin Live Educational Pro Chart

Reconstruction d'un tableau de bord éducatif de surveillance du marché Bitcoin :
graphique en chandeliers **composite multi-exchanges** (Binance, Coinbase, Kraken,
Bybit, OKX, Bitstamp fusionnés en un indice pondéré par les volumes), surveillance du
carnet d'ordres agrégé, scanner de tendance multi-timeframes, zones d'offre / demande,
retournements possibles, RSI, oscillateur « Momentum Wave », suivi de la condition de
marché, liquidations longs / shorts 24 h, calendrier économique avec compte à rebours,
panneau multi-actifs et alertes visuelles + sonores.

Application **Node.js** (serveur d'agrégation) + interface web (canvas), interface en
anglais comme l'original. Fonctionne dans un navigateur ou comme *source navigateur* OBS.

![dashboard](docs/screenshot.png)

---

## 1. Lancement rapide

**Windows — sans rien installer** : double-cliquer sur **`BTC-Monitor.exe`** (ou sur `Lancer BTC Monitor.bat`).
Une fenêtre de console s'ouvre (la garder ouverte pendant le direct, la fermer arrête le serveur) et le
tableau de bord s'ouvre tout seul dans le navigateur sur http://localhost:8787.

* L'exécutable contient le serveur, l'interface et une copie du réglage par défaut ; au premier lancement il
  crée `config.js` à côté de lui (à éditer pour changer les réglages) et le dossier `data/`.
* Les fichiers `public/` présents à côté de l'exécutable sont utilisés en priorité (l'interface reste modifiable).
* Windows SmartScreen peut afficher « Windows a protégé votre ordinateur » car l'exécutable n'est pas signé :
  cliquer sur *Informations complémentaires* → *Exécuter quand même*. (`BTC-Monitor.exe` est le node.exe
  officiel de nodejs.org — Node 24 LTS, maintenu jusqu'en avril 2028 — dans lequel le programme est injecté,
  voir `tools/build-exe.js` ; `npm run build:exe` le reconstruit.)
* Options en ligne de commande : `BTC-Monitor.exe --port 9000`, `--host 0.0.0.0`, `--config autre-config.js`, `--no-open`.

**macOS / Linux** : double-cliquer sur `start.command` (macOS) ou lancer `./start.sh` — Node.js ≥ 18 requis
(https://nodejs.org) ; les dépendances s'installent seules au premier lancement.

**Avec Node.js (toutes plateformes, développement)** :

```bash
cd BTC-Monitor
npm install          # ws (+ https-proxy-agent / undici, optionnels, pour le proxy)
npm start            # données live multi-exchanges (ajouter --open pour ouvrir le navigateur)
```

Ouvrir ensuite **http://localhost:8787** dans un navigateur (Chrome / Edge / Firefox).

### Une page par timeframe

Le même serveur alimente autant de pages que voulu, **une page = un timeframe** :

| Timeframe | Adresse |
|---|---|
| 1 min | http://localhost:8787/?tf=1m |
| 3 min | http://localhost:8787/?tf=3m |
| 5 min (défaut) | http://localhost:8787/?tf=5m |
| 15 min | http://localhost:8787/?tf=15m |
| 1 h | http://localhost:8787/?tf=1h |
| 4 h | http://localhost:8787/?tf=4h |
| 8 h | http://localhost:8787/?tf=8h |
| 12 h | http://localhost:8787/?tf=12h |
| 24 h (journalier) | http://localhost:8787/?tf=1d |

Les boutons `1 3 5 15 1H 4H 8H 12H 1D` en bas à droite ouvrent chaque timeframe (Ctrl/Cmd + clic
pour un nouvel onglet). Chaque page reçoit ses propres bougies, EMA, RSI, Momentum Wave, zones,
retournements, condition de marché et alertes ; le carnet, les liquidations, le scanner, le calendrier
et le panneau multi-actifs sont communs. Dans OBS, ajouter une source navigateur par timeframe.

Autres commandes :

| Commande | Rôle |
|---|---|
| `npm start` | serveur live (port 8787 par défaut) |
| `node server/index.js --port 9000` | changer le port |
| `node server/index.js --config autre-config.js` | utiliser un autre fichier de réglages que `config.js` |
| `npm test` | tests (indicateurs, moteur, parseurs des exchanges, serveur HTTP / WebSocket) — lancés aussi par la CI GitHub sur Node 18 à 24 |
| `npm run build:exe` | reconstruit `BTC-Monitor.exe` (Windows x64, Node 24 LTS) à partir des sources |

### Utilisation dans OBS

1. Lancer `BTC-Monitor.exe` (ou `npm start`) et le laisser tourner pendant le direct.
2. Sources → **+** → *Source navigateur*.
3. URL : `http://localhost:8787` (ou `http://localhost:8787/?tf=15m` pour un autre timeframe) — largeur 1920, hauteur 1080.
4. Cocher *Contrôler l'audio via OBS* pour entendre les alertes sonores dans le flux.

OBS sur un **second PC** : le serveur n'écoute par défaut que sur l'ordinateur local (`host: '127.0.0.1'`).
Mettre `host: '0.0.0.0'` dans `config.js` (ou lancer avec `--host 0.0.0.0`), autoriser le programme dans le
pare-feu, puis utiliser `http://<adresse IP du PC qui fait tourner BTC Monitor>:8787` dans OBS.

### Sur un serveur : adresse web et direct YouTube / Twitch 24 h/24 (Docker)

Sur un serveur loué (VPS Linux avec [Docker](https://docs.docker.com/engine/install/)), sans PC allumé :

```bash
git clone https://github.com/Speedystopia/BTC-Monitor.git && cd BTC-Monitor
cp .env.example .env        # puis le remplir : domaine, mentions légales, clés de stream, AdSense
docker compose up -d --build                                # tableau de bord seul (http://127.0.0.1:8787 sur le serveur)
docker compose --profile https up -d                        # + https://votre-domaine (certificat automatique)
docker compose --profile stream up -d --build               # + direct YouTube / Twitch
docker compose --profile https --profile stream up -d       # les trois
docker compose logs -f streamer                             # suivre le direct
```

* **Adresse web** (`--profile https`) : [Caddy](https://caddyserver.com) sert le tableau de bord en HTTPS sur le domaine
  `DOMAIN` de `.env` (le nom de domaine doit pointer vers le serveur, ports 80 et 443 ouverts). Pour le réserver à
  vous, décommenter le bloc `basic_auth` de `deploy/Caddyfile` (instructions dans le fichier).
* **Direct** (`--profile stream`, dossier `deploy/stream/`) : Chromium affiche la page sur un écran virtuel et ffmpeg
  envoie l'image et les alertes sonores vers YouTube (`YOUTUBE_STREAM_KEY`), Twitch (`TWITCH_STREAM_KEY`) et toute
  autre adresse RTMP (`RTMP_URLS`). L'image est encodée une seule fois ; chaque plateforme a son propre relais qui se
  reconnecte seul (Twitch coupe un direct au bout de 48 h) sans interrompre les autres. Page, timeframe et options
  comme dans OBS : `STREAM_PAGE=http://btc-monitor:8787/?tf=15m&heatgain=1.5`.
* **Ressources** mesurées : 1920×1080 à 30 i/s ≈ 1 cœur et 700 Mo de mémoire pour le direct, 1280×720 environ la
  moitié. Les vCPU de VPS étant souvent plus lents, prévoir 2 vCPU et 2 Go de mémoire au total pour le 1080p ;
  débit montant ≈ 6 Mb/s par plateforme.
* **Mentions légales et publicité** : `SITE_*` de `.env` remplissent la page `/privacy.html` (liée depuis le
  tableau de bord) ; `ADSENSE_CLIENT` / `ADSENSE_SLOT` ajoutent un bloc Google AdSense sous le carnet d'ordres.
  Seuls les visiteurs du domaine le voient : jamais dans le direct (page ouverte avec `?ads=0`, serveurs
  publicitaires bloqués), ni dans OBS, ni sur `localhost` (`?ads=0` le masque aussi sur votre écran).
* **Réglages** : monter votre `config.js` sur `/app/config.js` (ligne prévue dans `docker-compose.yml`) ; les données
  (liquidations, heatmap) sont conservées dans le volume `btcm-data`. Mise à jour :
  `git pull && docker compose --profile stream up -d --build`.
* Choisir un serveur **en Europe** : Binance, Bybit et OKX refusent les adresses américaines. Les cotations Yahoo
  (or, S&P 500, DXY) viennent d'un accès non officiel prévu pour un usage personnel : pour un direct public, vérifier
  leurs conditions ou retirer ces actifs de `config.js`.

---

## 2. Configuration — `config.js`

Tout se règle dans `config.js` (redémarrer le serveur après modification).

| Section | Réglages principaux |
|---|---|
| `port` | port HTTP / WebSocket du tableau de bord |
| `host` | interface d'écoute : `127.0.0.1` (défaut, cet ordinateur uniquement, pas d'alerte du pare-feu) ou `0.0.0.0` (accessible depuis le réseau local, ex. OBS sur un autre PC) |
| `chartTimeframe` | timeframe affiché quand la page est ouverte sans `?tf=` (défaut `5m`) |
| `chartTimeframes` | timeframes disponibles en pages : `1m 3m 5m 15m 1h 4h 8h 12h 1d` |
| `icons` | logos : téléchargés une fois depuis GitHub (organisations officielles des exchanges, dépôt `spothq/cryptocurrency-icons` pour les cryptos) dans `data/icons/`, sinon monogrammes intégrés |
| `visibleCandles` | nombre de bougies affichées (molette de la souris pour zoomer) |
| `exchanges` | exchanges fusionnés dans le chandelier composite (`enabled: true/false`, symbole) |
| `referenceExchange` | exchange dont le dernier prix est affiché comme étiquette secondaire (`CB` = Coinbase) |
| `syncClock` | aligne les bougies et comptes à rebours sur l'heure des exchanges plutôt que sur l'horloge de l'ordinateur (défaut `true`) |
| `liquidations` | flux de liquidations futures agrégés (Binance USDT-M + COIN-M, Bybit, OKX) |
| `orderBook` | seuils du moniteur de carnet : `largeOrderUsd` (taille mini d'un ordre listé), `minRestMs` (temps de repos mini), `feedRangePct`, `largeTradeUsd`, `bucketUsd` (profil de liquidité) |
| `indicators` | longueurs EMA / RSI, seuils de surachat-survente, EMA du scanner, fenêtre des zones, seuils du Momentum Wave, confirmation de la condition de marché |
| `assets` | panneau multi-actifs : source `binance` / `coinbase` (crypto, temps réel) ou `yahoo` (or, S&P 500, DXY…) |
| `calendar` | calendrier économique : flux hebdomadaire public, impact minimum, événements manuels |
| `heatmap` | heatmap de liquidité : `enabled`, `rangePct` (± % autour du prix enregistré, défaut 3), `historyHours` (historique conservé, défaut 72 h, dans `storeFile` = `data/heatmap.json`), `gain` (intensité par défaut, 1) |
| `sessions` | sessions de marché dessinées sur le graphique : nom, `start` / `end` (heures **UTC**, ou heures locales avec `tz` = fuseau IANA, heure d'été comprise, ex. `tz: 'Europe/London'`), couleur ; `maxTimeframe` (défaut `1h`) ; `enabled` |
| `alerts` | alertes audio / visuelles activées (`audio: false` = alertes sonores coupées par défaut) |
| `site` | site public (Docker : `.env`) : `domains` (nom(s) de domaine), `legal` (mentions légales de `/privacy.html`), `adsense` (`client` = identifiant d'éditeur, `slot` = bloc d'annonces) ; publicité et lien légal réservés aux visiteurs de ces domaines |
| `proxy` | proxy HTTP(S) sortant optionnel (réseaux d'entreprise) |

Exemple d'événement manuel :

```js
manualEvents: [
  { time: '2026-09-17T18:00:00Z', country: 'USD', title: 'FOMC Rate Decision', impact: 'High' },
],
```

---

## 3. Ce que montre chaque élément

| Élément | Fonctionnement |
|---|---|
| **Chandelier composite** | À chaque transaction reçue, un *prix indice* est recalculé : moyenne des derniers prix de chaque exchange pondérée par son volume récent (décroissance exponentielle 15 min, les flux muets > 60 s sont exclus). Les bougies (14 timeframes) sont construites sur cet indice ; le volume est la somme des exchanges. L'historique est chargé par REST sur chaque exchange puis fusionné (OHLC pondérés par les volumes). |
| **EMA 50** (ligne vert citron) | Tendance du timeframe du graphique ; sert aussi à la condition de marché. |
| **SUPPLY ZONE / DEMAND ZONE** | Recalculées **à chaque clôture de bougie** : la zone d'offre part du plus haut des `zoneLookback` dernières bougies clôturées (288 bougies, soit 24 h en 5 min, 12 jours en 1 h…) et descend de max(amplitude de cette bougie, 1 ATR) ; la zone de demande part du plus bas et monte de la même épaisseur. La bande est pleine à partir de la bougie qui a formé l'extrême et estompée avant. Quand une clôture dépasse l'extrême, la zone se déplace sur le nouveau sommet / creux ; quand l'ancien extrême sort de la fenêtre, elle glisse sur le suivant. La bougie en cours n'est jamais prise en compte (règle de confirmation). |
| **POSSIBLE REVERSAL** | Croisement du Momentum Wave sous / sur son signal peu après un extrême (Wave ≥ ±120 ou RSI ≥ 70 / ≤ 30). Le marqueur est posé sur le plus haut / plus bas de la fenêtre. Sur la bougie en cours il apparaît en transparence (*non confirmé*) et n'est validé qu'à la clôture — règle de confirmation de bougie. |
| **RSI** | RSI 14 (Wilder). Surachat ≥ 70 / survente ≤ 30 : halo rouge / vert, bandeau et son. |
| **MOMENTUM WAVE** (panneau bas) | Oscillateur de momentum (type WaveTrend ×2, plage ≈ ±250). Vert quand il est au-dessus de son signal, rouge sinon ; les barres verticales marquent les croisements. |
| **LAST CHANGE : BULLISH / BEARISH** + étiquette **BULLISH / BEARISH CONDITION** | Condition de marché : clôture au-dessus / en dessous de l'EMA 50, changement validé après `conditionConfirmBars` (2) clôtures consécutives de l'autre côté. Le texte en haut à droite donne l'état courant et l'ancienneté du dernier changement ; l'étiquette verte / rouge posée sur la bougie du changement (*BULLISH CONDITION* + RSI à cet instant) le situe sur le graphique ; un son est joué à chaque bascule. |
| **Heatmap de liquidité** (derrière les bougies) | Carte de chaleur des ordres limites **au repos** du carnet agrégé (tous les exchanges, achats + ventes) : chaque seconde, la liquidité est relevée par tranche de `bucketUsd` (10 $) jusqu'à ± `rangePct` du prix, puis moyennée par minute ; la colonne d'une bougie est la moyenne de ses minutes. Les gros ordres qui restent en place (murs) forment des **bandes horizontales** lumineuses (bleu → cyan → jaune → rouge = de plus en plus de liquidité), les cotations qui clignotent s'effacent. Les exchanges ne fournissent pas l'historique de leurs carnets : la heatmap se construit à partir du lancement du serveur et est conservée 72 h (`data/heatmap.json`, survit aux redémarrages). La légende (en bas à gauche) donne la liquidité affichée en couleur pleine, par tranche de prix (ex. `$2.4M / $10`) ; les touches **[** et **]** baissent / montent l'intensité. La page reçoit les colonnes des bougies visibles, puis celles des bougies plus anciennes quand on dézoome ou qu'on remonte le temps. |
| **Sessions de marché** (Sydney, Asia, Frankfurt, London, New York) | Comme les indicateurs de sessions de TradingView : pour chaque session de chaque jour, une boîte qui va du plus haut au plus bas des bougies de la session, avec son nom au-dessus. Horaires UTC par défaut, qui couvrent les 24 h sans chevauchement : Sydney 21:00-23:00, Asia 23:00-07:00, Frankfurt 07:00-08:00, London 08:00-13:00, New York 13:00-21:00. Pour suivre les vrais horaires d'une place (qui bougent d'une heure au changement d'heure), donner l'heure locale et le fuseau : `{ name: 'London', start: '08:00', end: '16:30', tz: 'Europe/London' }`. Affichées jusqu'au timeframe 1 h ; la session en cours s'agrandit avec les bougies. |
| **Trend / TF** (scanner) | Pour chaque timeframe 1 m → 1 D : pastille verte si la clôture est au-dessus de l'EMA 21 de ce timeframe, flèche ⬆ si l'EMA monte. |
| **6H … 1M** | Variation du prix indice par rapport à la clôture 6 h, 12 h, 24 h, 48 h, 72 h, 1 semaine et 30 jours plus tôt. |
| **Colonne gauche** (carnet d'ordres) | Les plus gros ordres limites **au repos** agrégés sur tous les exchanges (≥ `largeOrderUsd`, à ± `feedRangePct` du prix, présents depuis ≥ `minRestMs`), les plus récents en haut ; vert = achat (bid), rouge = vente (ask), l'intensité suit la taille. Le logo indique l'exchange (survol = nom + état) ; `✕` ordre retiré / exécuté (barré), `⚡` transaction unitaire ≥ `largeTradeUsd`. L'âge est le temps depuis l'apparition de l'ordre. |
| **Profil de liquidité** (barres à gauche du graphique) | Liquidité agrégée du carnet par tranche de `bucketUsd` : vert = bids, rouge = asks. |
| **24H TOTAL LIQUIDATIONS** | Somme glissante 24 h des liquidations futures (Binance, Bybit, OKX) : LONG = positions longues liquidées, SHORT = positions courtes. Agrégée par minute et persistée dans `data/liquidations.json` (écriture atomique, sauvegarde aussi à l'arrêt) pour survivre aux redémarrages. |
| **Next Economic Event** | Prochain événement (impact ≥ `minImpact`) du flux hebdomadaire public + événements manuels, compte à rebours `JJ:HH:MM:SS`. |
| **Panneau multi-actifs** | ETH, XRP, SOL en temps réel (Binance), GOLD / SP500 / DXY par sondage (Yahoo Finance, ~90 s). |
| **Bas de page** | Prix indice, variation 24 h, volume échangé sur la dernière minute (tous exchanges) avec jauge achat / vente, état des sources (pastilles + part de volume), timeframe. |

« **Composite · 5 exchanges** » dans l'en-tête indique que le chandelier est l'indice composite de 5 exchanges
connectés (source de données active).

Raccourcis : **M** = couper / réactiver le son, **H** = afficher / masquer la heatmap, **[** / **]** = intensité de la
heatmap, **S** = afficher / masquer les sessions (aussi via les boutons *HEATMAP* et *SESSIONS* en bas, choix mémorisés
par le navigateur). Souris : molette = zoom, **glisser** = remonter dans le temps (la vue reste sur ces bougies pendant
que de nouvelles arrivent), **double-clic** ou bouton *LIVE ▸* = revenir aux dernières bougies ; le **réticule** suit la
souris avec le prix et l'heure sur les axes et les valeurs de la bougie survolée (ouverture, plus haut, plus bas,
clôture, variation, volume, EMA, RSI ; Momentum Wave dans le titre du panneau du bas). Dans l'adresse, `?heatmap=0` / `?sessions=0` (ou `=1`) et
`?heatgain=1.5` imposent le choix quel que soit celui mémorisé (utile pour une source OBS :
`http://localhost:8787/?tf=15m&heatmap=1&sessions=0&heatgain=1.5`).

---

## 4. Architecture

```
btc-monitor/
├── BTC-Monitor.exe           lanceur Windows autonome (serveur + interface, sans Node.js)
├── Lancer BTC Monitor.bat    lanceur Windows (exe, ou Node.js si présent)
├── start.command / start.sh  lanceurs macOS / Linux (Node.js requis)
├── config.js                 réglages
├── Dockerfile                image du serveur (Node 24) ; docker-compose.yml : serveur + HTTPS + direct
├── deploy/
│   ├── Caddyfile             HTTPS (certificat automatique), mot de passe optionnel
│   └── stream/               image de diffusion YouTube / Twitch (Chromium, Xvfb, PulseAudio, ffmpeg)
├── server/
│   ├── index.js              point d'entrée : configuration, sauvegardes, sources de données
│   ├── http.js               serveur HTTP + WebSocket (fichiers, API, diffusion aux pages, clients lents)
│   ├── site.js               site public : mentions légales, ads.txt, Google AdSense (visiteurs du domaine)
│   ├── net.js                WebSocket reconnectant, fetch, proxy optionnel
│   ├── history.js            chargement de l'historique multi-exchanges
│   ├── calendar.js           calendrier économique
│   ├── assets.js             cotations Yahoo Finance (or, indices, DXY)
│   ├── icons.js              logos (GitHub) mis en cache dans data/icons
│   ├── clock.js              écart entre l'horloge de l'ordinateur et celle des exchanges
│   └── feeds/                un adaptateur par exchange (trades, carnet, liquidations, historique)
│       ├── index.js    registre des adaptateurs (ajouter un exchange ici)
│       ├── integrity.js  contrôle des carnets (CRC32 OKX / Kraken, séquences)
│       ├── binance.js  coinbase.js  kraken.js  bybit.js  okx.js  bitstamp.js
├── core/                     moteur (côté serveur)
│   ├── indicators.js         SMA, EMA, RSI, ATR, Momentum Wave, tendance, variations
│   ├── candles.js            timeframes, séries de bougies, fusion composite
│   ├── analysis.js           zones, retournements, condition, scanner, variations
│   ├── engine.js             prix indice, bougies live, carnet agrégé, feed, liquidations, messages
│   └── heatmap.js            heatmap de liquidité (colonnes par minute, agrégation par bougie, sauvegarde)
├── public/                   interface (index.html, styles.css, chart.js, app.js, sessions.js, audio.js, util.js)
│   ├── privacy.html          modèle des mentions légales et de la confidentialité (rempli par server/site.js)
│   └── fonts/                polices Barlow / Barlow Condensed servies localement (licence SIL OFL, OFL.txt)
├── tools/build-exe.js        construction de BTC-Monitor.exe (esbuild + Node SEA + postject)
├── test/run.js               tests (npm test)
└── .github/workflows/ci.yml  intégration continue (tests sur Node 18 à 24)
```

Flux : exchanges → adaptateurs (événements normalisés) → `Engine` → messages WebSocket
(`snapshot`, `tick`, `analysis`, `book`, `heat`, `orders`, `liq`, `scanner`, `pct`, `assets`,
`calendar`, `status`, `alert`) → interface. Plusieurs clients (navigateur + OBS) peuvent
être connectés en même temps. `GET /api/state` renvoie l'état complet en JSON.

---

## 5. Dépannage

* **« WAITING FOR MARKET DATA »** : le serveur n'a encore reçu aucune transaction.
  Regarder la console du serveur — chaque exchange y indique ses erreurs.
* **Binance / Bybit / OKX inaccessibles** : ces exchanges bloquent certains pays (États-Unis
  notamment). Désactiver l'exchange dans `config.js` (`enabled: false`) ; le composite
  fonctionne avec les autres. Les données de marché Binance passent par les points d'accès
  `data-api.binance.vision` / `data-stream.binance.vision`, disponibles partout ; seul le flux
  de liquidations futures (`fstream.binance.com`) reste soumis aux restrictions.
* **Pas d'or / S&P 500 / DXY** : Yahoo Finance limite parfois les requêtes (le serveur attend
  5 minutes puis réessaie). Les autres actifs continuent de se mettre à jour.
* **Pas d'événement économique** : le flux hebdomadaire n'est pas joignable ; ajouter des
  `manualEvents` dans `config.js`.
* **Logos** : Binance, Coinbase, Kraken, Bybit et OKX viennent de l'avatar de leur organisation GitHub
  officielle, BTC/ETH/XRP/SOL du dépôt `spothq/cryptocurrency-icons` (copies livrées dans `data/icons/`,
  re-téléchargées si absentes). Bitstamp n'a pas d'organisation GitHub officielle avec logo : un monogramme
  vert est utilisé — déposer `data/icons/bitstamp.png` ou indiquer une adresse dans `config.js` →
  `icons.sources` pour le remplacer.
* **Pas de son** : les navigateurs exigent un clic sur la page avant de jouer un son —
  cliquer sur *ENABLE AUDIO ALERTS* (dans OBS, cocher *Contrôler l'audio via OBS*).
* **Carnets d'ordres faussés** : une mise à jour perdue fausserait un carnet pour de bon (murs fantômes
  dans la heatmap et le flux des gros ordres). Chaque carnet est contrôlé : enchaînement des numéros de
  séquence (Binance, OKX, ordre croissant chez Bybit), somme de contrôle CRC32 des meilleurs niveaux
  envoyée par l'exchange (OKX : 25 niveaux, Kraken : 10), et pour tous un garde-fou : un carnet dont le
  meilleur achat reste au-dessus de la meilleure vente pendant 3 s est rechargé (au plus toutes les 30 s).
  Un carnet rechargé est écarté des agrégats jusqu'au nouvel instantané ; la console l'indique
  (`order book checksum mismatch: reloading`) et l'infobulle de l'exchange compte les rechargements.
  Si un exchange change de format, le contrôle concerné se désactive seul (une ligne dans la console)
  au lieu de recharger le carnet en boucle.
* **Horloge de l'ordinateur décalée** : au démarrage puis toutes les 10 minutes, le serveur demande
  l'heure à Binance, Coinbase, Bybit et OKX (comme NTP : on garde l'aller-retour le plus rapide de
  chacun, puis la médiane). Les bougies, les comptes à rebours et les âges utilisent cette heure ; la
  console indique l'écart et la barre d'état affiche `CLOCK +3.2S` dès qu'il atteint une seconde.
  Désactivable avec `syncClock: false`.
* **Réseau avec proxy** : renseigner `proxy` dans `config.js` (la variable d'environnement `HTTPS_PROXY`
  est reprise par défaut). Les modules nécessaires sont installés avec les dépendances (version Node.js ;
  l'exécutable Windows ne gère pas le proxy). Proxy qui inspecte le TLS : indiquer son certificat racine
  via la variable d'environnement `NODE_EXTRA_CA_CERTS`.

## 6. Limites connues

* Le flux de liquidations Binance ne publie qu'une liquidation par seconde et par symbole
  (limite de Binance) : les totaux sont indicatifs.
* Les paires USDT (Binance, Bybit, OKX) et USD (Coinbase, Kraken, Bitstamp) sont fusionnées
  sans conversion (option `normalizeUsdt: true` pour appliquer le cours USDT/USD de Kraken).
* Les cotations traditionnelles utilisent un point d'accès public non officiel de Yahoo.
* Tableau de bord **éducatif** — *Not Financial Advice*.
