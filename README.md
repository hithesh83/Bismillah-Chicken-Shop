# 🍗 Bismillah Chicken Shop – Management System

Internal management system built with **React + Vite** (frontend) and **Node.js + Express** (backend).

---

## Prerequisites

| Tool | Version | Check command |
|------|---------|---------------|
| Node.js | v18 or higher | `node -v` |
| npm | v9 or higher | `npm -v` |
| Git | any recent | `git --version` |

---

## Project Structure

```
Bismillah-Chicken-Shop/
├── client/            ← React + Vite frontend (port 5173)
│   ├── src/
│   │   ├── App.jsx    ← Home page component
│   │   ├── App.css
│   │   ├── main.jsx   ← React entry point
│   │   └── index.css
│   ├── index.html
│   ├── vite.config.js ← includes /api proxy → port 5000
│   └── package.json
├── server/            ← Node.js + Express backend (port 5000)
│   ├── src/
│   │   └── index.js   ← Express app + /api/health endpoint
│   └── package.json
├── .env.example       ← Copy this to .env and fill in values
├── .gitignore
└── README.md
```

---

## First-Time Setup

> **Windows users:** run all commands in **Command Prompt** or **PowerShell**, not Git Bash.

### 1 — Clone the repo (if you haven't already)

```
git clone <your-repo-url>
cd Bismillah-Chicken-Shop
```

### 2 — Set up environment variables

```
copy .env.example server\.env
```

> Open `server\.env` and fill in any values you need. For Phase 1, the defaults work fine.

### 3 — Install dependencies

```
cd client
npm install

cd ..\server
npm install
```

---

## Running in Development

You need **two separate terminal windows** — one for the frontend, one for the backend.

### Terminal 1 — Start the backend

```
cd server
npm run dev
```

Expected output:
```
✅ Server running on http://localhost:5001
   Health check → http://localhost:5001/api/health
```

### Terminal 2 — Start the frontend

```
cd client
npm run dev
```

Expected output:
```
  VITE v6.x.x  ready in xxx ms
  ➜  Local:   http://localhost:5173/
```

Then open **http://localhost:5173** in your browser.

---

## Verifying Everything Works

| Check | How |
|-------|-----|
| Backend running | Visit `http://localhost:5001/api/health` — should return JSON |
| Frontend running | Visit `http://localhost:5173` — should show the home page |
| Proxy working | The home page shows "Backend is running ✅" |

### Manual backend test (PowerShell)

```powershell
Invoke-WebRequest -Uri http://localhost:5001/api/health | Select-Object -ExpandProperty Content
```

### Manual backend test (Command Prompt / curl)

```
curl http://localhost:5001/api/health
```

Expected JSON response:
```json
{
  "status": "Backend is running ✅",
  "timestamp": "2026-10-15T16:45:00.000Z",
  "environment": "development"
}
```

---

## Git Workflow

```
git init
git add .
git commit -m "Phase 1: project scaffold"
```

> ⚠️ Never commit `.env`. It is listed in `.gitignore`.

---

## Roadmap

- [x] Phase 1 – Project scaffold (React + Vite + Express)
- [ ] Phase 2 – Database connection (Supabase PostgreSQL)
- [ ] Phase 3 – Authentication
- [ ] Phase 4 – Business features (inventory, orders, reports)
