#!/bin/sh
set -eu
broker_pid=''
stop_broker() {
  if [ -n "$broker_pid" ]; then kill -TERM "$broker_pid" 2>/dev/null || true; wait "$broker_pid" 2>/dev/null || true; fi
}
trap 'stop_broker; exit 0' TERM INT
start_broker() {
  /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
  broker_pid=$!
  echo "$broker_pid" > /tmp/mosquitto.pid
}
start_broker
previous=$(cksum /mosquitto/config/acl)
while kill -0 "$broker_pid" 2>/dev/null; do
  sleep 2 & wait $! || true
  current=$(cksum /mosquitto/config/acl)
  if [ "$current" != "$previous" ]; then
    # Disconnect existing sessions as well: removing an ACL must revoke an
    # already connected certificate, not only affect its next connection.
    stop_broker
    previous=$current
    start_broker
  fi
done
wait "$broker_pid"
