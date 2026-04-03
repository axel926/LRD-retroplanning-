# LRD · Rétro — Retroplanning La Réponse D.

App de retroplanning collaborative avec Gantt interactif, données persistantes Supabase, et déploiement Vercel.

---

## 🚀 Déploiement en 4 étapes

### 1. Supabase — Créer la base de données

1. Va sur [supabase.com](https://supabase.com) → New project
2. Donne un nom (ex. `lrd-retro`), choisis une région EU, crée un mot de passe fort
3. Attends 1-2 min que le projet démarre
4. Va dans **SQL Editor** → **New query**
5. Colle le contenu de `supabase-schema.sql` → **Run**
6. Va dans **Project Settings** → **API**
7. Copie :
   - `Project URL` → c'est ta `SUPABASE_URL`
   - `anon public` key → c'est ta `SUPABASE_ANON_KEY`

### 2. GitHub — Pusher le code

```bash
cd Desktop/lrd-retro
git init
git add .
git commit -m "init"
```

Puis sur github.com → New repository → `lrd-retro` → copie l'URL et :

```bash
git remote add origin https://github.com/TON_USERNAME/lrd-retro.git
git branch -M main
git push -u origin main
```

### 3. Vercel — Déployer

1. Va sur [vercel.com](https://vercel.com) → **Add New Project**
2. Importe ton repo GitHub `lrd-retro`
3. Dans **Environment Variables**, ajoute :
   - `NEXT_PUBLIC_SUPABASE_URL` = ta Project URL Supabase
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = ta anon key Supabase
4. Clique **Deploy**
5. Ton URL est prête en ~2 min 🎉

### 4. En local (optionnel)

```bash
cd Desktop/lrd-retro
cp .env.local.example .env.local
# Remplis les valeurs Supabase dans .env.local
npm install
npm run dev
# → http://localhost:3000
```

---

## Fonctionnalités

- **Multi-projets** avec couleur par projet
- **Gantt interactif** : drag & drop des blocs, redimensionnement
- **Étiquettes pré-définies** :
  - CRÉA → Mood · 3D · Validations client
  - PROD → Atelier · Logistique · Montage · Démontage
  - SOURCING
- **Vue annuelle** : tous les projets sur 12 mois
- **Temps réel** : les changements d'un·e collègue apparaissent instantanément
- **Persistance** : toutes les données sauvegardées en base

## Stack

- Next.js 14 (App Router)
- Supabase (PostgreSQL + Realtime)
- Vercel (hosting)
- TypeScript
