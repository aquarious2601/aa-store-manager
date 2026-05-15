#!/usr/bin/env bash
# AA Shop Manager — one-shot installer for Ubuntu 24.04.
#
# Sets up nginx, PHP 8.3 + FPM, MySQL 8, Node 20, Python 3.12 + Playwright,
# Composer, and certbot. Idempotent: re-runnable, skips anything already
# installed. Run as root (sudo).
#
# Usage:
#   sudo bash deploy/install.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root: sudo bash $0"
    exit 1
fi

APP_USER="${APP_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/home/ubuntu/aashop}"
MYSQL_DB="${MYSQL_DB:-aashop}"
MYSQL_USER="${MYSQL_USER:-aashop}"
MYSQL_PASS="${MYSQL_PASS:-aashop}"  # change in production!

echo "==> Updating apt cache"
apt-get update -y

echo "==> Installing base packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    nginx \
    git curl unzip ca-certificates gnupg lsb-release \
    mysql-server \
    python3 python3-venv python3-pip \
    certbot python3-certbot-nginx \
    fail2ban ufw

echo "==> Installing PHP 8.3 via ondrej PPA"
if ! command -v php8.3 >/dev/null 2>&1; then
    add-apt-repository -y ppa:ondrej/php
    apt-get update -y
fi
DEBIAN_FRONTEND=noninteractive apt-get install -y \
    php8.3 php8.3-fpm php8.3-cli \
    php8.3-mysql php8.3-mbstring php8.3-xml php8.3-intl \
    php8.3-curl php8.3-zip php8.3-bcmath php8.3-opcache

echo "==> Installing Composer"
if ! command -v composer >/dev/null 2>&1; then
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
fi

echo "==> Installing Node 20 via NodeSource"
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

echo "==> Configuring MySQL (bind to 127.0.0.1; create app DB + user)"
# MySQL 8 on Ubuntu 24.04 binds 127.0.0.1 by default; confirm anyway.
if ! grep -q "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf; then
    sed -i 's|\[mysqld\]|[mysqld]\nbind-address = 127.0.0.1|' /etc/mysql/mysql.conf.d/mysqld.cnf
fi
systemctl enable --now mysql
mysql --user=root <<SQL
CREATE DATABASE IF NOT EXISTS \`${MYSQL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${MYSQL_USER}'@'localhost' IDENTIFIED BY '${MYSQL_PASS}';
GRANT ALL PRIVILEGES ON \`${MYSQL_DB}\`.* TO '${MYSQL_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> Setting up the scraper venv + Playwright"
if [ -d "${APP_DIR}/scraper" ]; then
    sudo -u "${APP_USER}" bash -c "
        cd '${APP_DIR}/scraper'
        if [ ! -d .venv ]; then python3 -m venv .venv; fi
        source .venv/bin/activate
        pip install --upgrade pip
        pip install -r requirements.txt
        python -m playwright install chromium
    "
    # Playwright needs system libs (libnss, libatk, etc.) — let it install them
    "${APP_DIR}/scraper/.venv/bin/playwright" install-deps chromium || true
fi

echo "==> Enabling + starting services"
systemctl enable --now nginx php8.3-fpm

echo "==> Basic firewall (allow ssh / http / https)"
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable

echo
echo "================================================================"
echo "  Install complete."
echo
echo "  Next steps (see deploy/README.md for full instructions):"
echo "    1. Configure ${APP_DIR}/backend/.env.local"
echo "    2. Configure ${APP_DIR}/scraper/.env"
echo "    3. composer install + doctrine:schema:create + create-admin"
echo "    4. npm ci + npm run build in frontend/"
echo "    5. sudo cp deploy/nginx/aashop.conf /etc/nginx/sites-available/"
echo "       sudo ln -sf … /etc/nginx/sites-enabled/aashop"
echo "       sudo nginx -t && sudo systemctl reload nginx"
echo "    6. sudo certbot --nginx -d your-domain"
echo
echo "  MySQL user '${MYSQL_USER}' / password '${MYSQL_PASS}' on DB '${MYSQL_DB}'"
echo "  CHANGE THE PASSWORD with:"
echo "    sudo mysql -e \"ALTER USER '${MYSQL_USER}'@'localhost' IDENTIFIED BY 'NEW_PASSWORD';\""
echo "================================================================"
