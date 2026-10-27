#!/usr/bin/env bash
# One-time: the private S3 bucket the workspaces publish to, and a key that can reach only it.
#
#   tools/workspace/setup-bucket.sh <bucket-name> [--region us-east-1] [--import-state <card-state.json>]
#
# Runs with the aws CLI on this machine's default profile (the account owner). It creates:
#   - the bucket, with every form of public access blocked and versioning on (every run turns it on
#     again; it is never suspended, so an overwritten or deleted card can be brought back),
#   - an IAM user `buw-site-api` whose only policy is list, get and put on that bucket, delete under
#     sections/inbox/ only, and an explicit deny on deleting versions or changing versioning or
#     lifecycle rules, so history cannot be lost through this key,
#   - one access key for it, printed ONCE at the end for /srv/buw-docs/_app/api.env on the server.
# Safe to run again: each step checks before it creates, and a second run makes no second key.
#
# --import-state copies an existing card-state.json (from the server or .buw) to state.json in
# the bucket, so pins and archives survive the move. Skipped when state.json is already there.
set -euo pipefail

BUCKET="${1:-}"
REGION="us-east-1"
IMPORT=""
USER_NAME="buw-site-api"
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2;;
    --import-state) IMPORT="$2"; shift 2;;
    *) echo "Unknown option $1" >&2; exit 1;;
  esac
done
if [ -z "$BUCKET" ]; then
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
command -v aws >/dev/null || { echo "The aws CLI is not installed." >&2; exit 1; }
aws sts get-caller-identity --query Account --output text >/dev/null || { echo "The aws CLI has no working default profile." >&2; exit 1; }

echo "== Bucket s3://$BUCKET ($REGION)"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "   exists"
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  echo "   created"
fi
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
echo "   public access blocked; versioning on"

echo "== IAM user $USER_NAME"
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "   exists"
else
  aws iam create-user --user-name "$USER_NAME" --tags "Key=purpose,Value=buw workspaces bucket" >/dev/null
  echo "   created"
fi
POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::$BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::$BUCKET/*" },
    { "Sid": "InboxDeletesOnly", "Effect": "Allow", "Action": ["s3:DeleteObject"], "Resource": "arn:aws:s3:::$BUCKET/sections/inbox/*" },
    { "Sid": "NoHistoryLoss", "Effect": "Deny",
      "Action": ["s3:DeleteObjectVersion", "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration"],
      "Resource": ["arn:aws:s3:::$BUCKET", "arn:aws:s3:::$BUCKET/*"] }
  ]
}
JSON
)
aws iam put-user-policy --user-name "$USER_NAME" --policy-name "buw-bucket-$BUCKET" --policy-document "$POLICY"
echo "   policy: list/get/put on s3://$BUCKET, delete under sections/inbox/ only, no history loss"

if [ -n "$IMPORT" ]; then
  echo "== Card state"
  if aws s3api head-object --bucket "$BUCKET" --key state.json >/dev/null 2>&1; then
    echo "   state.json is already in the bucket; not overwriting it"
  else
    aws s3 cp "$IMPORT" "s3://$BUCKET/state.json" --content-type application/json >/dev/null
    echo "   imported $IMPORT as state.json"
  fi
fi

echo "== Access key"
EXISTING=$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  echo "   $USER_NAME already has a key ($EXISTING); its secret was shown when it was made."
  echo "   To issue a new one: aws iam delete-access-key --user-name $USER_NAME --access-key-id $EXISTING, then run this again."
else
  KEY=$(aws iam create-access-key --user-name "$USER_NAME" --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)
  ID=$(echo "$KEY" | cut -f1); SECRET=$(echo "$KEY" | cut -f2)
  cat <<EOT

   Put these four lines in /srv/buw-docs/_app/api.env on the server (root-only, chmod 600),
   then redeploy the service (site/deploy/publish-site-api.sh) so it restarts with them.
   This is the only time the secret is shown.

BUW_S3_BUCKET=$BUCKET
BUW_S3_REGION=$REGION
AWS_ACCESS_KEY_ID=$ID
AWS_SECRET_ACCESS_KEY=$SECRET

EOT
fi

cat <<EOT
== Next, on this machine
   npm run workspace migrate $BUCKET      # every registered workspace publishes to s3://$BUCKET/sections/<id>
   npm run publish -- --all               # upload the cards once
   npm run redeploy -- --site             # after the server is switched: is each section listed?
EOT
