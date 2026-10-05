# Indicateur de barre Zorin OS

## Verdict

La fonctionnalité est réalisable sur cette machine avec l’API tray native de Tauri. Un prototype AppIndicator temporaire a été lancé sous Zorin OS 18 / GNOME Shell 46 : une icône suivie du label dynamique `4.5 km/h` s’est affichée dans la barre et la mise à jour vers `4.6 km/h` a fonctionné. Le prototype a ensuite été arrêté sans modifier l’application.

L’environnement requis est déjà présent : l’extension `zorin-appindicator@zorinos.com` est active et `libayatana-appindicator3-1` est installée. Le code installé de l’extension Zorin lit `XAyatanaLabel` et l’affiche dans un `St.Label` ; de son côté, l’implémentation GTK de `tray-icon` transforme `set_title` en `AppIndicator::set_label`. Cette correspondance explique le succès du test réel ([source GTK de tray-icon 0.24.2](https://docs.rs/crate/tray-icon/0.24.2/source/src/platform_impl/gtk/mod.rs), [source de l’extension AppIndicator](https://github.com/ubuntu/gnome-shell-extension-appindicator/blob/master/indicatorStatusIcon.js)).

## Expérience recommandée

Dans la barre :

- icône Kalwol compacte ;
- total des calories actives de la journée, par exemple `1688 kcal` ;
- `— kcal` tant que l’historique local n’est pas disponible.

Dans le menu natif :

- `X382P — Connecté` ;
- `Vitesse : 4.50 km/h` ;
- `Séance : 01:22 · 5.86 km · 845 kcal` ;
- `Afficher l’application` ;
- `Quitter Kalwol Controller`.

Il vaut mieux ne pas placer Démarrer, Régler la vitesse, Pause ou Arrêt dans ce menu : un menu natif ne fournit pas la confirmation de sécurité déjà utilisée dans l’interface. L’arrêt physique doit rester le moyen d’urgence.

## Architecture proposée

1. Activer la feature Cargo `tauri/tray-icon`, requise par la documentation Tauri ([guide officiel Tauri](https://v2.tauri.app/learn/system-tray/)).
2. Créer un tray Rust dans `setup`, avec une icône et un menu fixe. Sous Linux, une icône peut ne pas apparaître sans menu et un menu attaché ne peut plus être remplacé, mais son contenu peut être modifié ([API `TrayIconBuilder`](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html)).
3. Mettre à jour le titre seulement lorsque le total quotidien arrondi change. `set_title` est prévu pour les informations numériques fréquemment actualisées sous Linux, même si certains environnements de bureau peuvent choisir de ne pas l’afficher ([API `TrayIconBuilder::title`](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html#method.title)).
4. Regrouper les changements de télémétrie dans une tâche native séparée avant de modifier les éléments du menu, afin que GTK ne puisse pas retarder les réponses de contrôle Bluetooth.
5. Envoyer depuis le frontend le total quotidien et un résumé de séance validés, car ces calculs et le profil sont actuellement conservés dans `localStorage`. Ces commandes ne doivent accepter aucune commande motrice.
6. Intercepter la fermeture de la fenêtre pour la masquer uniquement lorsque le tapis est hors ligne ou récemment confirmé en pause. `Quitter` déconnecte proprement le Bluetooth avant de terminer le processus.
7. Utiliser les événements du menu pour réafficher/focaliser la fenêtre. Les événements de clic direct sur l’icône tray ne sont pas émis sous Linux dans Tauri ; le menu reste donc le chemin portable ([limite Linux documentée](https://v2.tauri.app/learn/system-tray/#listen-to-tray-events)).

## Limites

- Le label texte est confirmé sur la configuration Zorin actuelle, mais Tauri précise qu’il peut être masqué par d’autres implémentations de barre.
- Les tooltips tray ne sont pas pris en charge sous Linux ([API Tauri](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html#method.tooltip)).
- La position exacte de l’indicateur est gérée par l’extension Zorin, pas par l’application.
- Une extension GNOME personnalisée donnerait davantage de contrôle visuel, mais ajouterait un second logiciel à installer et maintenir. Elle n’est pas nécessaire ici.

## Critères d’acceptation

- une seule icône Kalwol apparaît au lancement ;
- le label reflète le total des calories actives de la journée, sans mise à jour D-Bus inutile ;
- connexion, pause et déconnexion ont des libellés non ambigus ;
- le menu affiche les mêmes métriques de séance que l’application ;
- fermer la fenêtre la masque sans perdre la session lorsque le tapis est arrêté ;
- `Afficher l’application` restaure et focalise la fenêtre ;
- `Quitter` termine proprement la connexion BLE et retire l’indicateur ;
- aucune commande de mouvement n’est disponible depuis le menu tray.

## Validation à prévoir

- tests unitaires Rust du formatage des labels et des transitions connecté/pause/hors ligne ;
- tests de validation du résumé envoyé par le frontend ;
- test manuel sur cette machine : lancement, variation de vitesse, pause, reset du tapis, masquage/restauration et sortie ;
- contrôle qu’une reconnexion ou un rechargement frontend ne crée pas une deuxième icône ;
- contrôle de l’affichage après redémarrage de GNOME Shell sous X11.

## Sources principales

- [Tauri — System Tray](https://v2.tauri.app/learn/system-tray/)
- [Tauri — `TrayIconBuilder`](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html)
- [`tray-icon` 0.24.2 — implémentation GTK/AppIndicator](https://docs.rs/crate/tray-icon/0.24.2/source/src/platform_impl/gtk/mod.rs)
- [Ubuntu — extension GNOME AppIndicator](https://github.com/ubuntu/gnome-shell-extension-appindicator)
- [Spécification StatusNotifierItem](https://www.freedesktop.org/wiki/Specifications/StatusNotifierItem/)
