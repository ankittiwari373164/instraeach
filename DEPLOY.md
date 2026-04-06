# 🚀 InstaReach v4 — Railway Deployment Guide

Railway is the correct platform for this app (NOT Vercel).
Vercel is serverless and cannot run long background DM campaigns.
Railway runs like a real server — always on, persistent storage, background processes work.

---

## Step 1 — Create a GitHub Repository

1. Go to https://github.com and sign in (or create a free account)
2. Click the **+** button → **New repository**
3. Name it: `instraeach`
4. Set to **Private** (important — keeps your code secret)
5. Click **Create repository**
6. GitHub will show you commands. Run these on your PC:

```bash
# Open Command Prompt in your instraeach-v4 folder, then run:
git init
git add .
git commit -m "InstaReach v4 initial"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/instraeach.git
git push -u origin main
```

---

## Step 2 — Deploy on Railway

1. Go to https://railway.app and sign up with your GitHub account
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `instraeach` repository
4. Railway will start building automatically

---

## Step 3 — Set Environment Variables on Railway

In your Railway project → click your service → **Variables** tab → add these:

| Variable | Value |
|----------|-------|
| `PORT` | `3000` |
| `JWT_SECRET` | any long random string e.g. `abc123xyz987secretkey` |
| `ADMIN_USERNAME` | your chosen username |
| `ADMIN_PASSWORD` | your chosen strong password |

---

## Step 4 — Add a Persistent Volume (keeps your data safe)

Without a volume, your database and Instagram sessions reset on every redeploy.

1. In Railway → your service → **Volumes** tab
2. Click **Add Volume**
3. Mount path: `/app/data`
4. Click **Create**

This means your accounts, campaigns, sent DMs, and Instagram sessions are saved permanently.

---

## Step 5 — Get Your Public URL

1. In Railway → your service → **Settings** tab
2. Under **Networking** → click **Generate Domain**
3. You'll get a URL like: `https://instraeach-production.up.railway.app`
4. Open that URL — your dashboard is live 24/7!

---

## Step 6 — Update Your Code (when you make changes)

```bash
git add .
git commit -m "update"
git push
```
Railway auto-deploys every time you push to GitHub.

---

## ✅ Why Railway and not Vercel?

| Feature | Vercel | Railway |
|---------|--------|---------|
| Long-running processes | ❌ Kills after 10 sec | ✅ Runs forever |
| Background DM engine | ❌ Not possible | ✅ Works perfectly |
| Persistent database | ❌ Resets on cold start | ✅ Permanent with volume |
| Python support | ❌ Limited | ✅ Full support |
| Free tier | ✅ | ✅ 500 hrs/month free |

---

## 🆘 Troubleshooting

**Build fails with Python error:**
→ Railway → your service → Settings → Builder → switch to **Dockerfile**

**App crashes on start:**
→ Check Railway logs. Most likely a missing env variable (JWT_SECRET, ADMIN_PASSWORD)

**Sessions reset after redeploy:**
→ Make sure you added the Volume mounted at `/app/data`

**Can't reach the URL:**
→ Make sure PORT is set to `3000` in environment variables
