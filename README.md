# Decor Ops — Backend

Node + Express + SQLite (better-sqlite3) API for the Decor Ops mobile + web
app. JWT auth, owner/worker roles, plus the four core modules (Inventory,
Labor, Attendance, Vehicles) and supporting features (exports, Google Sheets
import, DB backups, push notifications, audit log).

## Local development

```bash
cp .env.example .env       # edit JWT_SECRET
npm install
npm start                  # → http://localhost:4000
```

On first start, a SQLite DB is auto-created at `data/decorops.db`. To bootstrap
the very first owner account:

```bash
npm run seed:owner -- --email you@yourcompany.com --password 'Strong#123' --name "Your Name"
```

## Environment variables

| Var                              | Required | Default                  | Purpose                                       |
| -------------------------------- | -------- | ------------------------ | --------------------------------------------- |
| `PORT`                           | no       | `4000`                   | HTTP listen port                              |
| `JWT_SECRET`                     | **yes**  | (none — refuse to start) | Token signing key — use a long random string  |
| `DB_PATH`                        | no       | `./data/decorops.db`     | SQLite file location (use a persistent path on Render/Fly) |
| `FIREBASE_SERVICE_ACCOUNT_JSON`  | no       | (none)                   | FCM service account JSON (string)              |
| `FIREBASE_SERVICE_ACCOUNT_PATH`  | no       | (none)                   | FCM service account JSON (file path)           |
| `BACKUP_S3_BUCKET`               | no       | (none)                   | S3-compatible bucket for remote backups        |
| `BACKUP_S3_ACCESS_KEY`           | no       | (none)                   | S3 access key                                  |
| `BACKUP_S3_SECRET_KEY`           | no       | (none)                   | S3 secret key                                  |
| `BACKUP_S3_REGION`               | no       | `us-east-1`              | S3 region                                     |
| `BACKUP_S3_ENDPOINT`             | no       | (none)                   | S3 endpoint (for B2 / MinIO)                   |
| `BACKUP_S3_PREFIX`               | no       | (none)                   | S3 key prefix                                 |

## Endpoints

See the project root `README.md` for the full API reference.

## Deploying

### Render.com (free tier, recommended)

1. Push this folder to a GitHub repo (see "Pushing to GitHub" below).
2. Sign in to [render.com](https://render.com) with GitHub → **New +** → **Web Service** → pick the repo.
3. Settings:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. **Environment** (Advanced → Add Environment Variable):
   - `JWT_SECRET` = some 64-char random string (e.g. from `openssl rand -hex 32`)
   - `DB_PATH` = `/var/data/decorops.db`
   - `PORT` = `10000` (Render default)
5. **Add Disk** (left sidebar → Disks → Add Disk):
   - Name: `decorops-data`
   - Mount Path: `/var/data`
   - Size: 1 GB
6. Click **Create Web Service**. After ~2 minutes you have a permanent URL like
   `https://decorops-api.onrender.com`. First request after idle takes ~30 s
   (cold start).

### Other hosts

- **Railway.app** — `railway up` after `railway link`
- **Fly.io** — `fly launch` then `fly volumes create decorops_data --size 1`
- **Self-host** — any Node 20+ host works. Set `JWT_SECRET` and `DB_PATH` env
  vars, expose port 4000, point a reverse proxy with HTTPS at it.

## Pushing to GitHub

```bash
cd backend
git init   # if not already
git add .
git commit -m "initial backend"
gh repo create braj14720-source/decor-ops-backend --public --source=. --remote=origin --push
```

If you don't have the `gh` CLI, push manually:
1. Create the empty repo on github.com (without README/license/.gitignore).
2. `git remote add origin https://github.com/braj14720-source/decor-ops-backend.git`
3. `git branch -M main`
4. `git push -u origin main` (it'll prompt for your GitHub credentials — use a
   Personal Access Token with `repo` scope).

## License

Private — for personal use.
