#!/bin/sh
set -eu
broker_pid=''
stop_broker() {
  if [ -n "$broker_pid" ]; then kill -TERM "$broker_pid" 2>/dev/null || true; wait "$broker_pid" 2>/dev/null || true; fi
  broker_pid=''
  rm -f /tmp/mosquitto.pid
}
trap 'stop_broker; exit 0' TERM INT
start_broker() {
  /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf &
  broker_pid=$!
  echo "$broker_pid" > /tmp/mosquitto.pid
}
previous=''
waiting=''
while :; do
  ready=true
  for file in /mosquitto/config/mosquitto.conf /mosquitto/config/acl /mosquitto/certs/client-ca.pem /mosquitto/certs/server.pem /mosquitto/certs/server.key; do
    if [ ! -s "$file" ]; then ready=false; fi
  done
  if [ "$ready" = false ]; then
    stop_broker
    if [ "$waiting" != true ]; then echo '{"event":"broker_waiting_for_certificates","listenerOpen":false}'; fi
    waiting=true
    sleep 2 & wait $! || true
    continue
  fi
  current=$(sha256sum /mosquitto/config/mosquitto.conf /mosquitto/config/acl /mosquitto/certs/client-ca.pem /mosquitto/certs/server.pem /mosquitto/certs/server.key) || continue
  if [ -z "$broker_pid" ] || ! kill -0 "$broker_pid" 2>/dev/null; then
    start_broker
  elif [ "$current" != "$previous" ]; then
    # Reload through a clean restart so revoked identities and replaced
    # certificates also take effect for already connected clients.
    stop_broker
    start_broker
  fi
  previous=$current
  waiting=false
  sleep 2 & wait $! || true
done
