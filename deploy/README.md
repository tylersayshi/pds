# deploy — laugh.town PDS build & push-deploy

This fork of the **`bluesky-social/pds` deployment repo** builds the laugh.town PDS image and
ships it to the bag box (`bag.laugh.town`) via an event-driven pipeline. `main` is based on the
`v0.4.5009` release (matching what prod runs) so the base image is version-neutral; the runtime
runs as **root** with the `/pds` data-dir conventions (unlike the atproto monorepo's dev image,
which runs as `node` and cannot open the `/pds` SQLite DB).

laugh.town-specific PDS changes (handle reservation, invite-to-claim signup, custom emails) live
in `@atproto/pds` internals and get layered in later as a patched dependency — the atproto
monorepo fork (`tylersayshi/atproto`) is the source of those patches. This repo owns the image
build, CI, and deploy tooling.

```
this fork ──git tag vX.Y.Z──▶ GitHub Actions (build linux/amd64, push)
                                 │ docker login atcr.io  (app password)
                                 ▼
                  atcr.io/laugh.town/pds:latest  (+ :vX.Y.Z, :sha-<short>)
                                 │ atcr fires "Image push" webhook (HMAC-SHA256)
                                 ▼
                  deployer on the bag box  (verify sig → deploy)
                                 │  docker compose pull pds && up -d pds
                                 ▼
                           recreated pds container
```

- **Event-driven**, not polled — Watchtower is removed from the box.
- **Tag-gated** — only a `vX.Y.Z` git tag publishes `:latest` and triggers a deploy. Pushes to
  `main` build a traceable `:sha-<short>` image but do **not** deploy.

## What's here
| Path | Destination | What it is |
|------|-------------|------------|
| `.github/workflows/build-push.yml` | this repo (CI) | build & push on tag/main |
| `deploy/box/compose.snippet.yaml` | bag box `/pds/compose.yaml` | pds image repoint, drop watchtower, add deployer |
| `deploy/box/Caddyfile.snippet` | bag box Caddy config | `/hooks/atcr` route → deployer |
| `deploy/box/deployer/` | bag box (e.g. `/pds/deployer`) | zero-dep webhook receiver |

The image build uses this repo's root `Dockerfile` (the bluesky-social/pds deployment image).

---

## Setup — your actions
Steps marked **[ACTION]** need you (a GitHub click, a secret, a shell command on the box).

### 1. App passwords — [ACTION]
Create **two** app passwords on the laugh.town PDS account (so either can be revoked alone):
- **CI** → GitHub secret (step 3)
- **box** → `docker login` on the bag box (step 4)

### 2. atcr webhook + namespace — [ACTION]
The image namespace is the logged-in handle → logging CI in as `laugh.town` gives
`atcr.io/laugh.town/pds`. In atcr's **Webhooks** panel:
- **URL**: `https://admin.laugh.town/hooks/atcr`
- **Signing Secret**: generate one — it becomes `ATCR_WEBHOOK_SECRET` on the box
- **Trigger Events**: **Image push** only

> ⚠️ First, point the webhook at a request bin, push one image, and capture the payload to
> confirm the deployer's tag filter (see `deploy/box/deployer/README.md`). A wrong filter
> restarts the PDS on every `:sha-*` build.

### 3. GitHub repo secrets — [ACTION]
Repo → Settings → Secrets and variables → Actions:
- `ATCR_HANDLE` = `laugh.town`
- `ATCR_APP_PASSWORD` = the **CI** app password

### 4. Box: authenticate Docker + wire the deployer — [ACTION]
On the bag box:
```sh
docker login atcr.io -u laugh.town        # paste the BOX app password
```
Then follow `deploy/box/deployer/README.md`:
- repoint `pds` image → `atcr.io/laugh.town/pds:latest`
- **remove** the `watchtower` service
- add the `deployer` service + Caddy route
- set `ATCR_WEBHOOK_SECRET`
- `docker compose -f /pds/compose.yaml up -d --build deployer`

### 5. First deploy — [ACTION]
```sh
git tag v0.1.0 && git push origin v0.1.0
```
Actions builds & pushes → atcr webhook → deployer logs `pull` + `up -d`.

---

## Rollback
Images are also tagged `:vX.Y.Z` and `:sha-<short>` (immutable). On the box, edit the `pds`
`image:` to a pinned tag and `docker compose up -d pds`.

## Keeping current with upstream
`upstream` remote points at `bluesky-social/pds`. `main` is pinned to a release tag (`v0.4.5009`);
bump it by rebasing the deploy commits onto a newer `vX` tag when you want a newer PDS base.

## Trade-offs
- **Restart blip**: `up -d pds` recreates the container; `bag.laugh.town` sessions drop for a few
  seconds per deploy. Tag-gating keeps this to intentional releases.
- **No migrations**: the deployer only swaps the image. Schema changes must run on PDS startup.
- **docker.sock exposure**: the deployer can control the daemon; it only acts on HMAC-verified
  requests and isn't exposed outside Caddy.
