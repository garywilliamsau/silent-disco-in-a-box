#!/bin/bash
# Silent Disco - Bluetooth Setup
# Prefers built-in BT (UART) since WiFi AP is on external USB adapter.
# Falls back to USB dongle if built-in is not available.

USB_DONGLE_MAC="5C:F3:70:8B:D2:C1"

# Unblock all BT radios
/usr/sbin/rfkill unblock bluetooth 2>/dev/null || true

# Bring all adapters up so hciconfig can read their MACs
hciconfig hci0 up 2>/dev/null || true
hciconfig hci1 up 2>/dev/null || true
sleep 2

# Find the built-in (UART) adapter
BUILTIN_HCI=$(hciconfig -a | awk '
  /^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur) }
  /Bus: UART/ { print cur }
')

if [ -n "$BUILTIN_HCI" ]; then
  echo "Using built-in BT at $BUILTIN_HCI"
  IDX=${BUILTIN_HCI#hci}

  # Set a stable BD address (built-in BCM often loads with a default/invalid address)
  BUILTIN_ADDR="DC:A6:32:AA:BB:CC"
  bluetoothctl power off 2>/dev/null || true
  btmgmt --index "$IDX" public-addr "$BUILTIN_ADDR" 2>/dev/null || true
  BT_MAC="$BUILTIN_ADDR"

  # Down USB dongle if present
  for i in 0 1; do
    [ "hci$i" != "$BUILTIN_HCI" ] && hciconfig "hci$i" down 2>/dev/null || true
  done
else
  echo "No built-in BT found — falling back to USB dongle" >&2
  # Find USB dongle by MAC
  USB_HCI=$(hciconfig -a | awk -v mac="$USB_DONGLE_MAC" '
    /^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur) }
    /BD Address:/ && $3 == mac { print cur }
  ')

  if [ -n "$USB_HCI" ]; then
    echo "Found USB dongle at $USB_HCI"
    BT_MAC="$USB_DONGLE_MAC"
    for i in 0 1; do
      [ "hci$i" != "$USB_HCI" ] && hciconfig "hci$i" down 2>/dev/null || true
    done
  else
    BT_MAC=$(hciconfig -a | awk '/BD Address:/ { print $3; exit }')
    if [ -z "$BT_MAC" ]; then
      echo "No BT adapter found at all!" >&2
      exit 1
    fi
    echo "Using first available adapter ($BT_MAC)"
  fi
fi

sleep 2

bluetoothctl << BTEOF
select $BT_MAC
power on
system-alias SilentDisco
discoverable on
pairable on
BTEOF
