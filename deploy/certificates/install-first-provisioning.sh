#!/bin/sh
set -eu
umask 077
bundle=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
host=/data/req/weathergateway
if [ "$(id -u)" != 0 ]; then echo 'Kjor som root eller med sudo.' >&2; exit 1; fi
if [ ! -d "$host" ] || [ -L "$host" ]; then echo 'Kontroller at /data/req/weathergateway er en vanlig mappe pa riktig montert disk.' >&2; exit 1; fi
if [ "$(CDPATH= cd -- "$host" && pwd -P)" != "$host" ]; then echo 'Hoststien kan ikke inneholde symbolske lenker.' >&2; exit 1; fi
# Check ALL destination paths before changing any identity.
find "$bundle/secrets/__ENVIRONMENT__" "$bundle/provisioning/__ENVIRONMENT__" "$bundle/__ENVIRONMENT__/system/certificate-import" -type f | while IFS= read -r src; do
  rel=${src#"$bundle"/}
  dest="$host/$rel"
  check="$dest"
  while [ "$check" != "$host" ]; do
    if [ -L "$check" ]; then echo "Symbolsk lenke avvist: $check" >&2; exit 1; fi
    check=$(dirname -- "$check")
  done
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -f "$dest" ]; }; then echo "Uventet maltype: $dest" >&2; exit 1; fi
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then echo "Avbrutt: eksisterende fil er forskjellig: $dest. Ingen eksisterende nokkel overskrives." >&2; exit 1; fi
done
find "$bundle/secrets/__ENVIRONMENT__" "$bundle/provisioning/__ENVIRONMENT__" "$bundle/__ENVIRONMENT__/system/certificate-import" -type f | while IFS= read -r src; do
  rel=${src#"$bundle"/}
  dest="$host/$rel"
  parent=$(dirname -- "$dest")
  install -d -o 10001 -g 10001 -m 0750 "$parent"
  case "$rel" in
    provisioning/*) mode=0600; chmod 0700 "$parent" ;;
    secrets/__ENVIRONMENT__/server.key) mode=0440 ;;
    secrets/__ENVIRONMENT__/*.key) mode=0400 ;;
    *) mode=0640 ;;
  esac
  if [ ! -f "$dest" ]; then install -o 10001 -g 10001 -m "$mode" "$src" "$dest"; fi
  chown 10001:10001 "$dest"
  chmod "$mode" "$dest"
done
echo 'Sertifikater installert uten overskriving. Kjor ordinart host-bootstrap med riktige produksjonsverdier, start stacken og importer enhetsregisteret som beskrevet i README.'
