# Production setup (Railway Postgres + Brevo)

## 1) PostgreSQL on Railway

1. Add a Railway Postgres service to the same project.
2. Copy `DATABASE_URL` from Postgres service and add it to backend service variables.
3. Deploy backend once, then run:

```bash
npm run pg:init
npm run pg:migrate-from-sqlite
npm run pg:check
```

`pg:check` should print connected DB and counts for `users` and `operators`.

## 2) SMTP via Brevo

Set these variables in backend service:

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<brevo_smtp_login>
SMTP_PASS=<brevo_smtp_key>
MAIL_FROM=Szept Kart <no-reply@szeptyanielskie.pl>
PUBLIC_BASE_URL=https://szeptyanielskie.pl
```

## 3) DNS for deliverability

In your DNS zone for `szeptyanielskie.pl`, add records required by Brevo:

- SPF
- DKIM
- optional DMARC

Without these records, verification emails can be delayed or rejected.

## 4) Verification testing checklist

1. Register a fresh user.
2. Confirm backend logs contain `[mail][verify][register]` with non-empty `accepted`.
3. If mail does not arrive, use `Wyślij link ponownie` on login page and check `[mail][verify][resend]`.
4. In `/operator` -> clients table, check `Status e-mail`.
