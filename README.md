# SENTINEL — Global Intelligence Platform

## Deploy to Vercel (5 minutes)

### 1. Install Vercel CLI
```bash
npm install -g vercel
```

### 2. Deploy
```bash
cd sentinel
vercel
```
Follow prompts: link to your account, deploy. Done.

### 3. Add your Anthropic API key (unlocks AI briefs + real correlations)
- Go to vercel.com → Your project → Settings → Environment Variables
- Add: `ANTHROPIC_API_KEY` = your key from console.anthropic.com
- Redeploy: `vercel --prod`

### 4. Your site is live at
```
https://your-project.vercel.app
```

---

## Alternative: Deploy via GitHub

1. Push this folder to a GitHub repo
2. Go to vercel.com → New Project → Import from GitHub
3. Select your repo → Deploy
4. Add `ANTHROPIC_API_KEY` in project settings

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/news?type=world` | Live geopolitical news (Guardian + GDELT) |
| `GET /api/news?type=mideast` | Middle East specific feed |
| `GET /api/threats` | Active global threat events |
| `GET /api/country?code=US` | Country intelligence card |
| `POST /api/analyze` | AI analysis (brief/correlations/actors/warnings) |

## Phase 2 Upgrades (next)
- ACLED conflict data integration
- Real-time entity extraction
- Automated daily briefings via email
- User accounts + watchlists
- CesiumJS globe migration
