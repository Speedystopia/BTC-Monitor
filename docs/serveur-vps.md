# Mettre BTC Monitor en ligne sur un VPS (adresse web, direct 24 h/24, publicité)

Guide pas à pas, du serveur loué au site en HTTPS avec le direct YouTube / Twitch et Google AdSense.
Les commandes se tapent dans le terminal du serveur (connexion SSH), sauf mention contraire.

## 0. Avant de commencer

* Les fichiers Docker font partie de la PR « Revue du code… » : **fusionnez-la** sur GitHub
  (bouton *Ready for review*, puis *Merge pull request*) pour qu'ils soient sur `main`.
* Il vous faut : une carte bancaire pour le VPS et le nom de domaine, un compte Google (AdSense, YouTube),
  un compte Twitch si besoin.

## 1. Louer le VPS

* **Emplacement : en Europe** (France, Allemagne, Finlande…). Binance, Bybit et OKX refusent les adresses
  américaines.
* **Système : Ubuntu 24.04 LTS.**
* **Taille :**
  * tableau de bord seul : 2 vCPU, 2 Go de mémoire ;
  * avec le direct : 2 vCPU et 2 Go au minimum en 1080p, **4 vCPU et 4 Go pour être tranquille** (le direct
    1080p à 30 i/s occupe environ un cœur et 700 Mo en continu ; en 720p, la moitié) ;
  * disque : 40 Go.
* **Trafic :** le direct envoie environ 2 To par mois et par plateforme (6 Mb/s). Vérifiez le trafic inclus
  dans l'offre (beaucoup d'offres incluent 20 To ou un trafic illimité).
* Hébergeurs possibles : OVHcloud, Scaleway, Hetzner…
* **Clé SSH** (sur votre PC, à faire avant la commande). Dans PowerShell (Windows) ou un terminal (Mac, Linux) :

  ```bash
  ssh-keygen -t ed25519
  ```

  Validez les questions (une phrase de passe est conseillée). Copiez le contenu du fichier
  `C:\Users\<vous>\.ssh\id_ed25519.pub` (Mac, Linux : `~/.ssh/id_ed25519.pub`) dans le champ « clé SSH » de la
  commande du VPS.
* Notez l'**adresse IP** du serveur (IPv4, et IPv6 s'il y en a une).

## 2. Le nom de domaine

1. Achetez un domaine (chez l'hébergeur du VPS ou un registrar : OVHcloud, Gandi, Infomaniak…).
   **Pour AdSense, utilisez le domaine lui-même** (`btcmonitor.fr`), pas un sous-domaine (`btc.monsite.fr`) :
   Google lit le fichier `btcmonitor.fr/ads.txt`.
2. Dans la zone DNS du domaine :
   * enregistrement **A**, nom `@` (vide), valeur = IPv4 du VPS ;
   * enregistrement **AAAA**, nom `@`, valeur = IPv6 du VPS (si vous en avez une) ;
   * supprimez les autres enregistrements A / AAAA de `@` (page de parking du registrar).
3. Attendez que `ping btcmonitor.fr` (sur votre PC) réponde avec l'IP du VPS : de quelques minutes à quelques
   heures.

## 3. Première connexion et sécurité

Depuis votre PC :

```bash
ssh root@IP_DU_VPS          # ou ubuntu@IP_DU_VPS selon l'hébergeur (voir son e-mail)
```

Si vous êtes connecté en `root`, créez votre utilisateur (sinon, passez à la suite) :

```bash
adduser btc                                          # choisissez un mot de passe : il servira pour sudo
usermod -aG sudo btc
rsync --archive --chown=btc:btc ~/.ssh /home/btc     # votre clé SSH ouvre aussi le compte btc
exit
```

```bash
ssh btc@IP_DU_VPS
sudo apt update && sudo apt full-upgrade -y
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable   # pare-feu
```

Recommandé : connexion SSH par clé uniquement, sans `root`. **Gardez la session ouverte** et vérifiez dans
un second terminal que `ssh btc@IP_DU_VPS` fonctionne encore après la commande :

```bash
printf 'PasswordAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/00-btc.conf
sudo systemctl restart ssh
```

Les mises à jour de sécurité d'Ubuntu s'installent seules (`unattended-upgrades`, actif par défaut) ; faites
un `sudo reboot` de temps en temps (les conteneurs redémarrent seuls).

## 4. Installer Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit                          # puis reconnectez-vous : ssh btc@IP_DU_VPS
docker run --rm hello-world   # doit afficher « Hello from Docker! »
```

## 5. Installer BTC Monitor et le mettre en ligne

```bash
git clone https://github.com/Speedystopia/BTC-Monitor.git
cd BTC-Monitor
cp .env.example .env
nano .env          # Ctrl+O puis Entrée pour enregistrer, Ctrl+X pour quitter
```

Dans `.env`, remplissez pour l'instant :

* `DOMAIN=btcmonitor.fr` (votre domaine) ;
* `SITE_EDITOR`, `SITE_CONTACT`, `SITE_HOSTING` : vos nom et adresse, votre e-mail, le nom, l'adresse et le
  téléphone de l'hébergeur (sur son site). Ils remplissent la page `/privacy.html` (mentions légales et
  confidentialité), obligatoire en France et pour AdSense. C'est un modèle à relire et à adapter, pas un
  conseil juridique.

Laissez vides les clés de stream et `ADSENSE_*` pour le moment.

```bash
docker compose --profile https up -d --build
docker compose ps            # btc-monitor passe « healthy » au bout d'une à deux minutes
docker compose logs -f       # Ctrl+C pour quitter
```

Ouvrez **https://btcmonitor.fr** : le tableau de bord s'affiche, avec un certificat valide (Caddy l'obtient et
le renouvelle seul). En cas d'erreur de certificat : le DNS ne pointe pas encore vers le VPS, ou les ports 80
et 443 sont fermés (`docker compose logs caddy` donne la raison).

Le site doit rester **public** pour AdSense : ne décommentez pas le bloc `basic_auth` de `deploy/Caddyfile`.

## 6. Le direct YouTube / Twitch

1. **YouTube** : YouTube Studio > **Créer** > **Passer au direct**. La première fois, la diffusion en direct
   doit être activée (vérification par téléphone, jusqu'à 24 h d'attente). Dans la salle de contrôle du direct,
   copiez la **clé de flux** (paramètres de diffusion) et laissez le démarrage automatique activé.
2. **Twitch** : Tableau de bord des créateurs > **Paramètres** > **Stream** > copiez la **clé de stream
   principale**.
3. Dans `.env` : `YOUTUBE_STREAM_KEY=…`, `TWITCH_STREAM_KEY=…`, et au besoin `STREAM_PAGE`
   (timeframe, options), `STREAM_WIDTH` / `STREAM_HEIGHT` (1280 / 720 si le serveur est juste).
4. Lancez :

   ```bash
   docker compose --profile https --profile stream up -d --build
   docker compose logs -f streamer     # « on air » pour chaque plateforme
   ```

Les clés ne s'affichent jamais dans les journaux. Le direct ne montre **jamais** de publicité (voir plus bas).

## 7. Au quotidien

```bash
cd ~/BTC-Monitor
git pull && docker compose --profile https --profile stream up -d --build   # mise à jour
docker compose --profile https --profile stream up -d                       # après une modification de .env
docker compose --profile https --profile stream restart streamer            # relancer le direct
docker compose --profile https --profile stream down                        # tout arrêter
docker image prune -f                                                        # place disque des anciennes images
```

Sans le direct, retirez `--profile stream` de ces commandes.

## 8. Google AdSense

La publicité s'affiche sous le carnet d'ordres (colonne de gauche ; sur téléphone, sous le graphique), avec un
lien « Legal · Privacy » vers `/privacy.html`. Elle n'est montrée qu'aux visiteurs de votre domaine :

* **jamais dans le direct** : le conteneur de diffusion ouvre la page avec `?ads=0` et ne peut pas joindre les
  serveurs publicitaires de Google ;
* **jamais dans OBS** (le tableau de bord le détecte), ni sur `http://localhost:8787` ;
* pour la masquer sur votre propre écran : ajoutez `?ads=0` à l'adresse.

C'est indispensable : des annonces affichées par une machine, en continu, sont du « trafic incorrect » pour
Google, qui ferme les comptes concernés.

**Avant de demander l'examen** : le site doit être en ligne, public, avec les mentions légales remplies.
AdSense refuse souvent les pages sans texte (« contenu à faible valeur ») ; une page d'explication (comment lire
la heatmap, les zones, les sessions, les liquidations…) augmente les chances d'être accepté.

1. **Créer le compte** : [adsense.google.com](https://adsense.google.com) > *Commencer*, avec votre compte
   Google. Donnez l'adresse du site (`btcmonitor.fr`), votre pays, puis complétez les informations de paiement
   (nom et adresse exacts : Google y enverra un code par courrier) et la vérification d'identité.
2. **Identifiant d'éditeur** : *Compte* > *Paramètres* > *Informations sur le compte* > *ID d'éditeur*
   (`pub-` suivi de 16 chiffres). Dans `.env` : `ADSENSE_CLIENT=pub-1234567890123456` (`ca-pub-…` fonctionne
   aussi), puis :

   ```bash
   docker compose --profile https --profile stream up -d
   ```

   Vérifiez que `https://btcmonitor.fr/ads.txt` affiche `google.com, pub-…, DIRECT, f08c47fec0942fa0`.
3. **Associer le site** : *Sites* > *Nouveau site* > `btcmonitor.fr` > méthode **Balise Meta** ou **Extrait
   ads.txt** (les deux sont déjà en place) > *Valider* > **Demander un examen**. La réponse arrive par e-mail,
   en quelques jours à quelques semaines.
4. **Consentement (obligatoire en Europe)** : *Confidentialité et messages* > **Réglementations européennes** >
   *Créer un message* pour votre site, puis *Publier*. Google affiche lui-même la demande de consentement aux
   visiteurs d'Europe, du Royaume-Uni et de Suisse, et le lien « Paramètres de confidentialité et des cookies »
   en bas de page.
5. **Après l'acceptation**, créer l'emplacement : *Annonces* > *Par bloc d'annonces* > **Annonces display** >
   un nom (ex. « Colonne gauche ») > *Créer*. Dans le code affiché, copiez le nombre de `data-ad-slot="…"`.
   Dans `.env` : `ADSENSE_SLOT=1234567890`, puis relancez comme à l'étape 2.
6. **Désactivez les annonces automatiques** : *Annonces* > *Par site* > crayon de votre site > décochez
   *Annonces automatiques* > *Appliquer au site*. Sinon Google place des annonces n'importe où, jusque sur le
   graphique.

Règles à respecter :

* ne cliquez jamais sur vos propres annonces et ne demandez pas aux spectateurs de cliquer ;
* ne montrez pas d'annonces dans le direct ni dans une vidéo (c'est automatique ici) ;
* gardez les mentions légales à jour (`SITE_*` dans `.env`).

Paiement : quand vos revenus atteignent une dizaine d'euros, Google envoie un code PIN par courrier (à saisir
dans AdSense) ; il paie ensuite chaque mois une fois le seuil de 70 € atteint. Ces revenus sont imposables : renseignez-vous sur la
déclaration et le statut adaptés (souvent micro-entrepreneur).

AdSense ne rémunère que le site. Pour gagner de l'argent avec le direct lui-même, il faut le Programme
Partenaire YouTube ou le statut Affilié Twitch, qui ont leurs propres conditions d'audience.
