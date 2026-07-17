# pegel-visual — Projekt-Notizen

- **Tests:** `node --test` — `tests/extract.mjs` evaluiert das Inline-Script aus `index.html` gegen Browser-Stubs (kein jsdom, kein Netz): `loadApp({search, now, width})`, dann `app.run('<expr>')` im App-Scope.
- **Node-Scripts mit Netzwerk laufen am Sandbox-Proxy vorbei:** undici/`fetch` kennt `HTTP_PROXY` nicht → `ENOTFOUND www.pegelonline.wsv.de`, obwohl `curl` denselben Host erreicht. Das ist die Sandbox, nicht DNS und nicht die App — ein Bypass pro Call statt Debugging (betrifft `scripts/fetch-wsv-archive.mjs` und Ad-hoc-Node gegen die WSV-APIs).
- **`archive`-Branch = GitHub-only Orphan-Datenbranch.** Pushes dorthin triggern nie einen Workflow (kein `.github/` im gepushten Commit) — Deploys brauchen den expliziten `gh workflow run pages.yml --ref main`; das Reseed-Runbook steht im Header von `scripts/fetch-wsv-archive.mjs`.
