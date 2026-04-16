# Production setup (Railway Postgres + Brevo)

## 1) PostgreSQL on Railway

1. Add a Railway Postgres service to the same project.
2. Copy `DATABASE_URL` from Postgres service and add it to backend service variables.
3. Deploy backend once, then run:

```bash
npm run pg:init
npm run pg:migrate-from-sqlite
```

Po migracji sprawdź w panelu operatora (np. lista klientów) lub w Railway → Postgres → Query, czy w bazie są rekordy.

## 2) Operator panel URL (security by obscurity)

Do not rely on `/operator` on production. Set a long, random `OPERATOR_PANEL_PATH` in Railway (for example `/zz-a7k9m2xq-praca`). The app serves the panel only under that prefix. Share the full URL only with staff.

## 3) SMTP via Brevo

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

## 4) DNS for deliverability

In your DNS zone for `szeptyanielskie.pl`, add records required by Brevo:

- SPF
- DKIM
- optional DMARC

Without these records, verification emails can be delayed or rejected.

## 5) Verification testing checklist

1. Register a fresh user.
2. Confirm backend logs contain `[mail][verify][register]` with non-empty `accepted`.
3. If mail does not arrive, use `Wyślij link ponownie` on login page and check `[mail][verify][resend]`.
4. In the owner clients table in the operator panel (URL path from `OPERATOR_PANEL_PATH`), check `Status e-mail`.
