# Deploying AA Shop Manager to AWS EC2

Single-box production deploy: nginx + PHP-FPM + MySQL + the scrapers, all on one
Ubuntu 24.04 EC2 instance in `us-east-2`, with free TLS from Let's Encrypt.

This guide walks through everything from "I just made an AWS account" to
"the app is live at https://your-domain". Allow about 45 minutes for the first
deploy.

## Cost

| Item | Spec | Cost |
|---|---|---|
| EC2 instance | `t3.small` (2 vCPU, 2 GB RAM) on-demand | ~$15 / month |
| EBS storage | 30 GB gp3 | ~$2.40 / month |
| Elastic IP | one, always attached | free (charged only if unattached) |
| Data transfer out | 1 GB free, then ~$0.09/GB | ~$0 for a small shop |
| **Total** | | **~$17 / month** |

If RAM ever runs tight (Playwright Chromium uses ~400 MB while scraping, MySQL
takes another ~400 MB), bump to `t3.medium` (4 GB) for ~$30/month total.

## 1. AWS console — launch the instance

1. Open the EC2 console in **us-east-2** (Ohio).
2. **Launch Instance**:
   - Name: `aashop-prod`
   - **AMI: Ubuntu Server 24.04 LTS** (HVM, 64-bit x86). DO NOT pick a
     non-LTS Ubuntu (25.04, 25.10, etc.) — they're not supported by the
     Ondrej PHP PPA and you'll get 404s during install. 24.04 LTS is
     supported through 2029.
   - Instance type: `t3.small`
   - Key pair: create a new one (`aashop-key.pem`), download and save it
   - Network settings → **Edit** → Security group inbound rules:
     - SSH (22) — your IP only
     - HTTP (80) — anywhere
     - HTTPS (443) — anywhere
   - Storage: 30 GB gp3
3. **Launch** the instance.
4. From the EC2 dashboard, allocate an **Elastic IP** and **associate it** to
   the new instance. This pins the public IP so DNS records don't break on
   stop/start.

## 2. DNS

Point an A record on your domain (e.g. `app.aashop.com`) at the Elastic IP.
TTL 300s is fine. Confirm with `dig app.aashop.com` from your laptop.

## 3. First SSH

```bash
chmod 400 aashop-key.pem
ssh -i aashop-key.pem ubuntu@<elastic-ip>
```

## 4. Run the installer

The repo includes a one-shot installer that sets up everything. Clone the repo
first (or upload it via `scp`).

```bash
# On the EC2 instance, as the ubuntu user:
sudo apt-get update
sudo apt-get install -y git
git clone <your-repo-url> /home/ubuntu/aashop
cd /home/ubuntu/aashop
sudo bash deploy/install.sh
```

The script installs nginx, PHP 8.3 + extensions, MySQL 8, Node 20, Python 3.12 +
Playwright, and Composer. Re-running it is safe — it skips anything already
installed.

## 5. Configure secrets

```bash
# Backend
cd /home/ubuntu/aashop/backend
cp .env.local.example .env.local
nano .env.local
# - APP_ENV=prod        (CRITICAL on production — otherwise Symfony tries
#                        to load MakerBundle which composer --no-dev skipped)
# - APP_DEBUG=0
# - APP_SECRET: paste a random 32-char hex
# - JWT_PASSPHRASE: paste another random 32-char hex
# - DATABASE_URL: change user/password to match what install.sh created
#   ("aashop"/"aashop" by default — change in MySQL with ALTER USER if you want)
```

Generate two random secrets:

```bash
openssl rand -hex 32  # for APP_SECRET
openssl rand -hex 32  # for JWT_PASSPHRASE
```

```bash
# Scraper
cd /home/ubuntu/aashop/scraper
cp .env.example .env
nano .env
# - KOCO_EMAIL / KOCO_PASSWORD (koreancosmetics.fr)
# - KCODEON_LOGIN / KCODEON_PASSWORD (Dolibarr admin)
```

## 6. Initialise the database + secrets

```bash
cd /home/ubuntu/aashop/backend
composer install --no-dev --optimize-autoloader --no-interaction
# Every console command below runs in prod mode (APP_ENV=prod is also in
# .env.local, so the --env flag is belt-and-braces).
php bin/console doctrine:database:create --if-not-exists --env=prod
php bin/console doctrine:schema:create --env=prod
php bin/console lexik:jwt:generate-keypair --env=prod
php bin/console app:create-admin login password --env=prod   # default admin
php bin/console cache:clear --env=prod --no-debug
sudo chown -R www-data:www-data var/ config/jwt/
sudo chmod -R 775 var/
```

## 7. Build the React frontend

The frontend is served by nginx as static files. Build once, deploy to a
location nginx can read.

```bash
cd /home/ubuntu/aashop/frontend
# Point the build at the production API
echo "VITE_API_BASE=/api" > .env.production
npm ci
npm run build
# dist/ now contains the static site
```

## 8. nginx + TLS

```bash
# Copy the nginx config provided in the repo
sudo cp /home/ubuntu/aashop/deploy/nginx/aashop.conf /etc/nginx/sites-available/aashop
# Edit `server_name` to your real domain
sudo nano /etc/nginx/sites-available/aashop
sudo ln -sf /etc/nginx/sites-available/aashop /etc/nginx/sites-enabled/aashop
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t && sudo systemctl reload nginx

# Let's Encrypt — interactive, follow prompts
sudo certbot --nginx -d app.aashop.com
# certbot will update the nginx config to add TLS + auto-renew via systemd timer
```

Open `https://app.aashop.com` in your browser, log in with `login` / `password`,
and change the password from the Users page immediately.

## 9. (Optional) Scheduled scrapes

The "Fetch new orders" / "Fetch new sales" buttons work on the deployed app
too, but if you want background scraping (every morning, say), add a cron:

```bash
crontab -e
# Add (runs at 06:00 server time, server time is UTC on EC2 by default):
0 6 * * * cd /home/ubuntu/aashop/scraper && /home/ubuntu/aashop/scraper/.venv/bin/python scrape_orders.py >> /var/log/aashop-cron.log 2>&1
30 6 * * * cd /home/ubuntu/aashop/scraper && /home/ubuntu/aashop/scraper/.venv/bin/python scrape_sales.py >> /var/log/aashop-cron.log 2>&1
0 7 * * * cd /home/ubuntu/aashop/backend && php bin/console app:import-orders ../scraper/orders.json >> /var/log/aashop-cron.log 2>&1
15 7 * * * cd /home/ubuntu/aashop/backend && php bin/console app:import-sales  ../scraper/sales.json  >> /var/log/aashop-cron.log 2>&1
```

Make sure both `CREATE_ONLY=1` and `SALES_CREATE_ONLY=1` are set in
`scraper/.env` so the nightly runs only fetch what's new.

## 10. Backups

Daily mysqldump → /var/backups/aashop, kept 14 days:

```bash
sudo cp /home/ubuntu/aashop/deploy/backup.sh /usr/local/bin/aashop-backup
sudo chmod +x /usr/local/bin/aashop-backup
sudo crontab -e
# Add:
30 3 * * * /usr/local/bin/aashop-backup
```

For real durability, sync `/var/backups/aashop/` to an S3 bucket — one extra
line at the bottom of `backup.sh` using `aws s3 cp`. Lifecycle the bucket to
Glacier after 30 days.

## 11. Routine operations

```bash
# Restart PHP / nginx after a config change
sudo systemctl reload nginx
sudo systemctl restart php8.3-fpm

# Pull new code + rebuild
cd /home/ubuntu/aashop
git pull
(cd backend  && composer install --no-dev --optimize-autoloader && php bin/console cache:clear --env=prod && php bin/console doctrine:schema:update --force)
(cd frontend && npm ci && npm run build)
sudo systemctl reload nginx

# Tail the logs
sudo journalctl -u nginx -f
sudo journalctl -u php8.3-fpm -f
tail -f /home/ubuntu/aashop/backend/var/log/prod.log
tail -f /var/log/aashop-cron.log
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `502 Bad Gateway` from nginx | PHP-FPM down. `sudo systemctl restart php8.3-fpm` |
| `500` from /api/* with no message | Wrong file permissions on `var/cache`. `sudo chown -R www-data:www-data backend/var && sudo chmod -R 775 backend/var` |
| `401` even with correct password | JWT keypair missing. Re-run `lexik:jwt:generate-keypair` and `chown www-data config/jwt/*.pem` |
| Scraper times out on EC2 | Playwright Chromium might be missing system libs. `sudo /home/ubuntu/aashop/scraper/.venv/bin/playwright install-deps chromium` |
| Out of memory during build | t3.small has 2 GB RAM. Build the frontend locally and `scp dist/` instead, or upgrade to t3.medium |

## Security checklist

- [ ] SSH inbound rule restricted to your IP (not 0.0.0.0/0)
- [ ] `ubuntu` user requires the .pem key (no password SSH)
- [ ] MySQL not exposed externally (bind 127.0.0.1 — `install.sh` already does this)
- [ ] HTTPS working (green padlock in the browser)
- [ ] Admin password changed from the default `password`
- [ ] `.env.local` / `scraper/.env` not committed anywhere
- [ ] Daily mysqldump backup running
- [ ] If you opened SSH to the world, install fail2ban (`sudo apt install fail2ban`)
