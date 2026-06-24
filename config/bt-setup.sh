#!/bin/bash
# Silent Disco - Bluetooth Setup
# Prefers the USB BT dongle (proven reliable for A2DP). Falls back to the built-in
# adapter only if the dongle isn't present. Hardened so it can never hang the
# oneshot service: the built-in's btmgmt public-addr step (which hangs on some Pi
# BCM adapters) is guarded with a timeout, and the dongle path skips it entirely.

USB_DONGLE_MAC="5C:F3:70:8B:D2:C1"

# Unblock all BT radios
/usr/sbin/rfkill unblock bluetooth 2>/dev/null || true

# Bring all adapters up so hciconfig can read their MACs
hciconfig hci0 up 2>/dev/null || true
hciconfig hci1 up 2>/dev/null || true
sleep 2

# hciX for a given BD address
hci_for_mac() {
  hciconfig -a | awk -v mac="$1" '
    /^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur) }
    /BD Address:/ && toupper($3) == toupper(mac) { print cur; exit }'
}

# Find the built-in (UART) adapter's hciX
builtin_hci() {
  hciconfig -a | awk '
    /^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur) }
    /Bus: UART/ { print cur; exit }'
}

# Bring up the chosen adapter, down the others, make it discoverable.
# $1 = hciX, $2 = BD address to select in bluetoothctl
activate() {
  local hci="$1" mac="$2" i
  for i in 0 1; do
    [ "hci$i" != "$hci" ] && hciconfig "hci$i" down 2>/dev/null || true
  done
  hciconfig "$hci" up 2>/dev/null || true
  sleep 1
  bluetoothctl <<BTEOF
select $mac
power on
system-alias SilentDisco
discoverable on
pairable on
BTEOF
  echo "Bluetooth ready on $hci ($mac)"
}

# --- Prefer the USB dongle ---
DONGLE_HCI=$(hci_for_mac "$USB_DONGLE_MAC")
if [ -n "$DONGLE_HCI" ]; then
  echo "Using USB dongle at $DONGLE_HCI"
  activate "$DONGLE_HCI" "$USB_DONGLE_MAC"
  exit 0
fi

# --- Fallback: built-in adapter ---
BUILTIN_HCI=$(builtin_hci)
if [ -n "$BUILTIN_HCI" ]; then
  echo "USB dongle not found — falling back to built-in BT at $BUILTIN_HCI" >&2
  IDX=${BUILTIN_HCI#hci}
  BUILTIN_ADDR="DC:A6:32:AA:BB:CC"
  # The built-in BCM often loads with an invalid/duplicate address; try to set a
  # stable one, but never block on it (this command hangs on some adapters).
  hciconfig "$BUILTIN_HCI" down 2>/dev/null || true
  timeout 5 btmgmt --index "$IDX" public-addr "$BUILTIN_ADDR" 2>/dev/null \
    || echo "btmgmt public-addr skipped (timeout/unsupported)" >&2
  hciconfig "$BUILTIN_HCI" up 2>/dev/null || true
  activate "$BUILTIN_HCI" "$BUILTIN_ADDR"
  exit 0
fi

# --- Last resort: first adapter we can find ---
FIRST_HCI=$(hciconfig -a | awk '/^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur); print cur; exit }')
if [ -n "$FIRST_HCI" ]; then
  FIRST_MAC=$(hciconfig "$FIRST_HCI" 2>/dev/null | awk '/BD Address:/ { print $3; exit }')
  echo "Using first available adapter $FIRST_HCI ($FIRST_MAC)" >&2
  activate "$FIRST_HCI" "$FIRST_MAC"
  exit 0
fi

echo "No BT adapter found at all!" >&2
exit 1
