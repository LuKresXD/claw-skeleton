# systemd config snapshot (DR backup)

Version-controlled mirror of the live claw-* systemd units + reliability drop-ins from `/etc/systemd/system/`. Added 2026-05-28 (audit WS-3/DR) because the service topology was previously unbacked - a VPS wipe would have lost every timer/service definition.

## What's here
- `claw-*.timer` / `claw-*.service` - all claw units (snapshot)
- `claw-*.service.d/10-claw-reliability.conf` - the OnFailure/Restart drop-ins added in WS-2

## Secrets are REDACTED
Inline `Environment=` secret values (e.g. `GOG_KEYRING_PASSWORD`) are replaced with `<REDACTED-in-backup>` here. The live units hold the real values. On restore, re-insert secrets from `claw-bot/.env` / `secrets/` (or better: migrate inline secrets to `EnvironmentFile=` - see audit finding).

## Restore (after VPS rebuild)
1. `cp claw-bot/systemd/claw-*.{timer,service} /etc/systemd/system/`
2. `cp -r claw-bot/systemd/claw-*.service.d /etc/systemd/system/`
3. Re-insert any redacted inline secrets into the live units (or convert to EnvironmentFile).
4. `systemctl daemon-reload && systemctl enable --now <units>`

## Keep in sync
This is a manual snapshot. Re-run `cp` + commit after any systemd unit change. (Backlog: a cron to auto-sync + commit this mirror nightly.)
