#!/usr/bin/env bash
# Install the pull-based site deploy on the VM (user, dirs, SELinux, timer, nginx). Re-runnable.
#   sudo -v && deploy/install-sync.sh   (from a checkout of this repository)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
id bash-web >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin bash-web
sudo install -d -m 0755 -o bash-web -g bash-web /srv/bash-sim /srv/bash-sim/releases
if command -v semanage >/dev/null 2>&1; then
  if ! sudo semanage fcontext -l | grep -q '^/srv/bash-sim(/.\*)?'; then
    sudo semanage fcontext -a -t httpd_sys_content_t '/srv/bash-sim(/.*)?'
  fi
  sudo restorecon -R /srv/bash-sim
fi
sudo install -m 0755 "$root/deploy/bash-site-sync.sh" /usr/local/libexec/bash-site-sync
sudo install -m 0644 "$root/deploy/systemd/bash-site-sync.service" "$root/deploy/systemd/bash-site-sync.timer" /etc/systemd/system/
sudo install -m 0644 "$root/deploy/nginx/bash.conf" "$root/deploy/nginx/bash-headers.inc" /etc/nginx/apps.badita.com.d/
sudo systemctl daemon-reload
sudo systemctl enable -q --now bash-site-sync.timer
sudo systemctl start bash-site-sync.service   # first pull now (needs branch "site" on GitHub)
sudo nginx -t
sudo systemctl reload nginx
echo "installed; live release: $(readlink /srv/bash-sim/bash || echo none yet)"
