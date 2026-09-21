#!/usr/bin/env bash
# Minimal EBMS OData helper — handles the token dance so exploration is one command.
#
#   export EBMS_BASE="https://<serial>.koblesystems.dev/MyEbms/<COMPANY>/OData"
#   export EBMS_USER=... EBMS_PASS=...
#
#   ./ebms.sh get "/INVENTRY?\$filter=contains(tolower(DESCR_1),'shovel')&\$top=5"
#   ./ebms.sh post /INVENTRY '{"ID":"ZTEST","TREE_ID":"16","DESCR_1":"Test"}'
#   ./ebms.sh patch "/ARINV(123)" '{"Details@delta":[{"INVEN":"ABC","M_QUAN_VIS":"1"}]}'
#
# The token is cached in a 0600 temp file so repeated calls don't re-login. Credentials
# are read from the environment and never written to disk.
set -euo pipefail

: "${EBMS_BASE:?set EBMS_BASE}" ; : "${EBMS_USER:?set EBMS_USER}" ; : "${EBMS_PASS:?set EBMS_PASS}"
BASE="${EBMS_BASE%/}"
CACHE="${TMPDIR:-/tmp}/.ebms-token-$(printf '%s' "$BASE$EBMS_USER" | shasum | cut -c1-12)"

token() {
  # Reuse a token younger than 9 minutes; they expire around 10.
  if [ -f "$CACHE" ] && [ "$(( $(date +%s) - $(stat -f %m "$CACHE" 2>/dev/null || echo 0) ))" -lt 540 ]; then
    cat "$CACHE"; return
  fi
  local body
  body=$(jq -nc --arg u "$EBMS_USER" --arg p "$EBMS_PASS" '{Username:$u,Password:$p}')
  local t
  t=$(curl -s -X POST "$BASE/Token" -H 'Content-Type: application/json' -d "$body" | jq -r '.AccessToken // empty')
  [ -n "$t" ] || { echo "EBMS login failed" >&2; exit 1; }
  ( umask 077; printf '%s' "$t" > "$CACHE" )
  printf '%s' "$t"
}

cmd="${1:?usage: ebms.sh get|post|patch <path> [json]}"; path="${2:?missing path}"; payload="${3:-}"
TOK=$(token)

case "$cmd" in
  get)   curl -s -H "Authorization: Bearer $TOK" -H 'Accept: application/json' "$BASE$path" ;;
  post)  curl -s -X POST  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$payload" "$BASE$path" ;;
  patch) curl -s -X PATCH -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$payload" "$BASE$path" ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac | jq .
