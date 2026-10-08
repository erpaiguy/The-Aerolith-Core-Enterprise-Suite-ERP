#!/usr/bin/env bash
# Creates deploy/.env from deploy/.env.example with fresh secrets. Refuses to overwrite an existing file.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f .env ]]; then
  echo "deploy/.env already exists; not overwriting. Delete it first if you really want new secrets." >&2
  exit 1
fi
rand() { head -c 32 /dev/urandom | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='; }
cp .env.example .env
chmod 600 .env
set_var() { # replaces KEY= line, value may contain any character except newline
  python3 - "$1" "$2" <<'PY'
import sys, re
key, value = sys.argv[1], sys.argv[2]
p = '.env'
s = open(p).read()
s = re.sub(rf'^{re.escape(key)}=.*$', lambda m: f'{key}={value}', s, count=1, flags=re.M)
open(p, 'w').write(s)
PY
}
set_var POSTGRES_PASSWORD "$(rand)"
set_var SESSION_SIGNING_KEY "$(rand)"
set_var LICENCE_KEY_PEPPER "$(rand)"
set_var CONTROL_PLANE_ENC_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
pem="$(openssl genpkey -algorithm ed25519 2>/dev/null | awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}')"
set_var ENTITLEMENT_PRIVATE_KEY_PEM "\"${pem}\""
echo "Created deploy/.env with new secrets (permissions 600)."
echo "Next: review PUBLIC_API_URL / WEBSITE_URL / email settings, then make an encrypted offline copy of deploy/.env."
