#!/bin/bash
# NetworkManager dispatcher: keep SilentDisco WiFi hotspot up when ethernet connects.
# NM may soft-block the WiFi radio when a wired connection comes up; this re-enables it.
#
# Deployed to: /etc/NetworkManager/dispatcher.d/10-keep-wifi-up

IFACE="$1"
ACTION="$2"

[ "$IFACE" = "eth0" ] || exit 0
[ "$ACTION" = "up" ] || exit 0

# Re-enable WiFi radio (NM may have soft-blocked it when wired connected)
nmcli radio wifi on

# Give the radio a moment to come back up
sleep 2

# Restart hostapd if it stopped when the radio was blocked
if ! systemctl is-active --quiet hostapd; then
    systemctl restart hostapd
fi
