#!/usr/bin/env bash
#
# Manual Cloud Run deploy for ntentan-api-live.
#
# Mirrors the api/ submodule's GitHub Actions deploy, adapted for the Live API
# edition: a distinct service/image, its own env secret, and these Socket.IO /
# Gemini-Live tuning flags:
#   --session-affinity  sticky sessions so a socket stays on one instance.
#   --min-instances=1   keeps one instance warm; without it the service scales
#                       to zero between sessions and the next connection cold-
#                       starts (~20s hang while Node boots + opens the Live API).
#   --no-cpu-throttling CPU stays allocated for the life of the long-lived
#                       WebSocket + streaming Gemini session (not just during
#                       request bursts), so background TTS/keepalive work runs.
#   --timeout=3600s     a Socket.IO WebSocket is one long-lived HTTP request, so
#                       Cloud Run's request timeout caps how long a session can
#                       stay open. Set to the 60-min max (default is 5 min) per
#                       Cloud Run's WebSockets guidance so conversations aren't
#                       force-closed mid-stream. (No cross-instance state to sync
#                       — each socket is a standalone user↔Gemini session — so the
#                       Redis-adapter part of that guidance does not apply.)
# NOTE: these do NOT fix Gemini-side "Internal error encountered." session
# closes (an upstream transient) — that needs a server-side reconnect/retry.
#
# Prereqs: gcloud authenticated on project furwoodd-775d1, docker running, and
# `gcloud auth configure-docker us-west1-docker.pkg.dev`.
#
# Usage:  ./scripts/deploy-cloudrun.sh            # tag = git short sha
#         IMAGE_TAG=hotfix ./scripts/deploy-cloudrun.sh
#
set -euo pipefail

PROJECT="${PROJECT:-furwoodd-775d1}"
REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-ntentan-api-live}"
REPO="${REPO:-ntentan}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-ntentan-temp@furwoodd-775d1.iam.gserviceaccount.com}"
ENV_SECRET="${ENV_SECRET:-ntentan-api-live-env}"
FIREBASE_SECRET="${FIREBASE_SECRET:-NTENTAN_FIREBASE_CREDENTIALS}"
CRED_PATH="/usr/src/ntentan-api/secrets/firebase-cred.json"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || date +%s)}"
IMAGE="us-west1-docker.pkg.dev/${PROJECT}/${REPO}/api-live:${IMAGE_TAG}"

echo ">> Building ${IMAGE} (linux/amd64)"
docker build --platform linux/amd64 -t "$IMAGE" "$HERE"
docker push "$IMAGE"

echo ">> Composing env vars from secret ${ENV_SECRET}"
RAW_ENV=$(gcloud secrets versions access latest --secret="$ENV_SECRET" --project="$PROJECT")
if [ -z "$RAW_ENV" ]; then
  ENV_VARS="NODE_ENV=PRODUCTION"
else
  ENV_VARS=$(printf "%s" "$RAW_ENV" | grep -vE '^\s*#|^\s*$' | tr '\n' ',' | sed 's/,$//')
  # Drop any NODE_ENV coming from the secret, then force PRODUCTION.
  ENV_VARS=$(printf "%s" "$ENV_VARS" | sed -E 's/(^|,)NODE_ENV=[^,]*(,|$)/\1\2/g' | sed 's/,,/,/g' | sed 's/^,//' | sed 's/,$//')
  ENV_VARS="${ENV_VARS},NODE_ENV=PRODUCTION"
fi

echo ">> Deploying ${SERVICE} to Cloud Run (${REGION})"
gcloud run deploy "$SERVICE" \
  --image="$IMAGE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --service-account="$SERVICE_ACCOUNT" \
  --update-env-vars="$ENV_VARS" \
  --update-secrets="${CRED_PATH}=${FIREBASE_SECRET}:latest" \
  --session-affinity \
  --min-instances=1 \
  --no-cpu-throttling \
  --timeout=3600s

gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format='value(status.url)'
