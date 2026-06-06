# Momnz VPS Panel PRO v4

Mini cPanel production UI for Ubuntu 24.04/22.04: VPS health care, website deploy, Docker containers, domain proxy, backups, logs, settings, CyberPanel integration.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/rickeyward17653-max/momnz/main/install.sh -o /tmp/install.sh && chmod +x /tmp/install.sh && sudo REPO_URL="https://github.com/rickeyward17653-max/momnz.git" bash /tmp/install.sh
```

## Update existing VPS

```bash
cpanel-update
```

Runtime folders are preserved:

- `/opt/mini-cpanel/data`
- `/opt/mini-cpanel/sites`
- `/opt/mini-cpanel/backups`

## Check

```bash
cpanel-status
```
# new-us
