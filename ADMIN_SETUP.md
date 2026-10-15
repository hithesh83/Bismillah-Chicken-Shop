# Admin Account Setup & Credential Management

This document explains how to create the first Admin account, how to reset a password, and how to manage credentials safely.

---

## First-Time Setup

### Prerequisites

Before creating an admin account, make sure:

1. **Migrations have been applied** — the `users` table must exist:
   ```bash
   npm --prefix server run db:migrate
   ```

2. **`.env` is configured** with a real `DATABASE_URL_DIRECT` (your Supabase direct connection).

3. **`JWT_SECRET` is set** in `.env`:
   ```bash
   # Generate a strong secret (run once, paste into .env):
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

---

## Creating the First Admin

Run the provisioning script **in a terminal** (it requires an interactive TTY — it cannot be run from a script or CI pipeline, by design):

```bash
npm --prefix server run admin:provision
```

You will be prompted for:

| Prompt | What to enter |
|--------|--------------|
| Display name | Full name, e.g. `Mohammed Hithesh` |
| Email address | Login email, e.g. `admin@bismillah.local` |
| Password | Minimum 10 characters. **Not echoed to the terminal.** |
| Confirm password | Re-enter the same password. |

The password is hashed with **bcrypt (cost factor 12)** before it is written to the database. The plain-text password is immediately overwritten in memory after hashing.

### What the script does

- If the email **does not exist**: creates a new `admin` user.
- If the email **already exists**: updates the password hash and promotes the role to `admin`.

This means you can safely run the script again to reset any admin's password.

---

## Resetting a Password

```bash
npm --prefix server run admin:provision
```

Enter the **same email address** as the existing account. The script will update the password and confirm the action.

---

## Security Rules

| Rule | Why |
|------|-----|
| Never commit `.env` to Git | It contains `JWT_SECRET` and database credentials |
| Rotate `JWT_SECRET` if it leaks | All existing tokens are invalidated immediately |
| Use passwords of 10+ characters | Enforced by the provisioning script |
| Each person must have their own account | Never share admin credentials |
| Accounts lock after 5 failed attempts | Brute-force protection; unlock via `admin:provision` |

---

## Unlocking a Locked Account

Run `npm --prefix server run admin:provision` with the locked account's email. The script resets `failed_login_attempts = 0` and `locked_until = NULL`.

---

## Environment Variables Reference

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Signing secret for all JWTs. Min 32 bytes. Rotate if leaked. |
| `CLIENT_ORIGIN` | Frontend URL allowed for CORS cookies (e.g. `http://localhost:5173`) |
| `DATABASE_URL_DIRECT` | Supabase direct connection on port 5432 (not Transaction Pooler) |

Generate a new `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

After rotating, all active sessions expire — users must log in again.
