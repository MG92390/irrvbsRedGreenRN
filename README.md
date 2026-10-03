# Verb Club

Application mobile Expo pour réviser les verbes irréguliers anglais, conçue pour fonctionner dans Expo Go.

## Démarrer

```sh
npm install
npx expo start
```

Scannez le QR code avec Expo Go pour ouvrir l’application sur un téléphone. `npm run web` permet aussi un aperçu dans un navigateur.

## Organisation

- `App.tsx` contient les écrans, le déroulement d’une manche et l’interface du quiz.
- `src/data/verbs.ts` définit les dix listes et les formes des verbes.
- `src/services/verbStats.ts` centralise les statistiques enregistrées localement avec AsyncStorage.

Le lexique et les règles du quiz sont indépendants du stockage. Pour la migration dans Scholaria, le service `verbStats` pourra être remplacé par le service de persistance du projet hôte.

Dans `verbLists`, renseignez `expectedScore` pour définir le score attendu d'une liste. Le record de l'élève est conservé sur son appareil. Le record global nécessite un service serveur partagé et reste donc indisponible dans cette version locale.

## Règles

Chaque manche dure 30 secondes. Une question expire après 5 secondes; une réponse fausse ou expirée rapporte 0 point. Une bonne réponse rapporte 5 points sous 1 s, 3 points sous 1,2 s, 2 points sous 1,4 s et 1 point jusqu’à 5 s. La moyenne de réponse et le taux de réussite sont suivis séparément pour chaque verbe.
