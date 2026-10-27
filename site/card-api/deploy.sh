#!/usr/bin/env bash
# Build and deploy the card API stack with SAM.
#
#   site/card-api/deploy.sh <bucket-name> [--domain api.workspaces.example.net] [--region us-east-1]
#                           [--stack buw-card-api] [--origins https://a.example.net,http://localhost:3009] [--new-passphrase]
#
# The domain, region, stack and allowed origins start from "cardApi" in ~/.buw/deploy.json
# (BUW_DEPLOY_CONFIG moves that file), then BUW_CARD_API_DOMAIN / _REGION / _STACK / _ORIGINS, then the flags.
# The origins are passed on every deploy: CloudFormation resets a parameter that is left out to its default.
# Uses the aws CLI's default profile (or AWS_PROFILE); AWS CloudShell works too. The first run asks
# for the passphrase agents will use; later runs keep it unless --new-passphrase is given. The
# Route 53 zone for the domain is found by name. Optional extra tokens come from
# ~/.buw/card-api-tokens (new-token.mjs), when that file exists.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"

BUCKET="${1:-}"
# One key of "cardApi" in ~/.buw/deploy.json (an array is joined with commas), or the second argument.
deploy_setting() {
  BUW_DEPLOY_FILE="${BUW_DEPLOY_CONFIG:-$HOME/.buw/deploy.json}" KEY="$1" FALLBACK="${2:-}" node -e '
    let v = process.env.FALLBACK;
    try { const c = JSON.parse(require("fs").readFileSync(process.env.BUW_DEPLOY_FILE, "utf8")).cardApi || {}; if (c[process.env.KEY] != null) v = [].concat(c[process.env.KEY]).join(","); } catch {}
    process.stdout.write(v);
  '
}
DOMAIN="${BUW_CARD_API_DOMAIN:-$(deploy_setting domain)}"
REGION="${BUW_CARD_API_REGION:-$(deploy_setting region us-east-1)}"
STACK="${BUW_CARD_API_STACK:-$(deploy_setting stack buw-card-api)}"
ORIGINS="${BUW_CARD_API_ORIGINS:-$(deploy_setting origins)}"
NEW_PASSPHRASE=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --stack) STACK="$2"; shift 2;;
    --origins) ORIGINS="$2"; ORIGINS_SET=1; shift 2;;
    --new-passphrase) NEW_PASSPHRASE=1; shift;;
    *) echo "Unknown option $1" >&2; exit 1;;
  esac
done
if [ -z "$BUCKET" ] || [ -z "$DOMAIN" ]; then
  [ -n "$BUCKET" ] && echo "No domain: set \"cardApi\".\"domain\" in ~/.buw/deploy.json, or pass --domain." >&2
  sed -n '2,12p' "$SELF" | sed 's/^# \{0,1\}//'
  exit 1
fi
if [ -z "$ORIGINS" ] && [ "${ORIGINS_SET:-}" != "1" ]; then
  echo "No allowed origins: set \"cardApi\".\"origins\" in ~/.buw/deploy.json, or pass --origins a,b." >&2
  echo "Deploying with none removes CORS from the live API; pass --origins '' to do that on purpose." >&2
  exit 1
fi
# On Windows the SAM installer adds sam.cmd, which Git Bash does not find as `sam`. Git Bash also
# cannot pass an argument with spaces (the passphrase) to a .cmd under C:\Program Files, so run
# the Python that sam.cmd itself runs.
SAM=(sam)
if ! command -v sam >/dev/null; then
  SAM_CMD=$(command -v sam.cmd || true)
  [ -n "$SAM_CMD" ] || { echo "The sam CLI is not installed, or not on PATH yet (open a new terminal after installing). AWS CloudShell has it." >&2; exit 1; }
  SAM=("$(dirname "$SAM_CMD")/../runtime/python.exe" -m samcli)
fi
command -v aws >/dev/null || { echo "The aws CLI is not installed (AWS CloudShell has it)." >&2; exit 1; }

# The zone whose name is the longest suffix of the domain: api.workspaces.example.net -> example.net (the longest one that exists).
ZONE=""
name="$DOMAIN"
while [ -z "$ZONE" ] && [[ "$name" == *.* ]]; do
  ZONE=$(aws route53 list-hosted-zones-by-name --dns-name "$name." --max-items 1 \
    --query "HostedZones[?Name=='$name.' && Config.PrivateZone==\`false\`].Id | [0]" --output text 2>/dev/null | tr -d '\r' | sed 's#/hostedzone/##')
  [ "$ZONE" = "None" ] && ZONE=""
  name="${name#*.}"
done
[ -n "$ZONE" ] || { echo "No public Route 53 zone found for $DOMAIN." >&2; exit 1; }

# The origins list has commas, so it is quoted like the passphrase (SAM splits overrides on spaces).
OVERRIDES=("BucketName=$BUCKET" "BucketRegion=$REGION" "DomainName=$DOMAIN" "HostedZoneId=$ZONE" "AllowedOrigins='$ORIGINS'")

if ! aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" >/dev/null 2>&1; then
  NEW_PASSPHRASE=1
fi
if [ -n "$NEW_PASSPHRASE" ]; then
  read -r -s -p "Passphrase for agents (16+ characters, e.g. four random words): " PASS; echo
  read -r -s -p "Again: " AGAIN; echo
  [ "$PASS" = "$AGAIN" ] || { echo "They differ." >&2; exit 1; }
  [ "${#PASS}" -ge 16 ] || { echo "At least 16 characters, please." >&2; exit 1; }
  [[ "$PASS" =~ ^[A-Za-z0-9\ ]+$ ]] || { echo "Letters, digits and spaces only, please." >&2; exit 1; }
  # SAM splits override values on spaces unless they are quoted.
  OVERRIDES+=("Passphrase='$PASS'")
fi

TOKENS_FILE="${BUW_CARD_TOKENS_FILE:-$HOME/.buw/card-api-tokens}"
if [ -f "$TOKENS_FILE" ]; then
  OVERRIDES+=("TokenHashes=$( { grep -Ev '^[[:space:]]*(#|$)' "$TOKENS_FILE" || true; } | tr -d '\r' | paste -sd, -)")
fi

"${SAM[@]}" build
"${SAM[@]}" deploy \
  --stack-name "$STACK" \
  --region "$REGION" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${OVERRIDES[@]}"

echo
echo "Done. Agents need BUW_CARDS_PASSWORD, and the address: \"cardApi\": \"https://$DOMAIN\" in ~/.buw/config.json (or BUW_CARD_API)."
