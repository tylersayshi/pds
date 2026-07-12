# deployer — atcr webhook → pull & restart

Tiny zero-dependency Node service. Receives atcr's **Image push** webhook, verifies the
`X-Webhook-Signature-256` HMAC, and runs `docker compose pull pds && up -d pds` on the box.
Replaces Watchtower polling with event-driven deploys.

## Install on the bag box
1. Copy this directory onto the box (e.g. `/pds/deployer`).
2. Add the `deployer` service from `../compose.snippet.yaml` to `/pds/compose.yaml`.
3. Add the Caddy route from `../Caddyfile.snippet`.
4. Set `ATCR_WEBHOOK_SECRET` in the box's environment (same value as atcr's Webhooks panel).
5. `docker compose -f /pds/compose.yaml up -d --build deployer`
6. Health check: `curl -fsS http://localhost:8787/healthz` (from inside the compose net) or hit
   `https://admin.laugh.town/hooks/atcr` with a bad body → expect `401`.

## Environment
| Var | Default | Purpose |
|-----|---------|---------|
| `ATCR_WEBHOOK_SECRET` | — (required) | HMAC signing secret; must match atcr |
| `COMPOSE_FILE` | `/pds/compose.yaml` | compose file the deploy acts on |
| `DEPLOY_SERVICE` | `pds` | service to pull & recreate |
| `DEPLOY_TAG` | `latest` | only pushes of this tag deploy |
| `PORT` | `8787` | listen port (internal) |

## Payload filter (confirmed 2026-07-11)
The filter in `server.js` matches atcr's real payload: `trigger === "push"`,
`push_data.tag === DEPLOY_TAG`, `repository.repo_name === EXPECTED_REPO`. Note a single push
fires ~3 webhook calls — two untagged manifests (image + attestation) and one tagged OCI index;
only the index carries `push_data.tag`, so gating on the tag dedupes to one deploy per push.
If atcr changes its payload shape, re-capture and update the `FILTER` block.

## Security
Mounts the Docker socket (root-equivalent on the host). Mitigations: not published to the host
(only Caddy reaches it), every request HMAC-verified, 1 MB body cap, `/pds` mounted read-only.
Keep the signing secret strong and rotate it if the box is ever compromised.
