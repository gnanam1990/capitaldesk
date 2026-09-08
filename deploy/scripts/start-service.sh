#!/bin/sh
set -eu

case "${CAPITALDESK_DATABASE_URL_REF:-}" in
  file:///*)
    database_url_path=${CAPITALDESK_DATABASE_URL_REF#file://}
    DATABASE_URL=$(cat "$database_url_path")
    export DATABASE_URL
    ;;
  *)
    echo 'CAPITALDESK_DATABASE_URL_REF must be a file:// secret reference' >&2
    exit 64
    ;;
esac

exec "$@"
