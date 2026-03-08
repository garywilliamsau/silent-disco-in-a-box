#!/bin/bash
# Silent Disco - Bluetooth Setup
# Works on both Pi 4 (hci0=built-in, hci1=USB) and Pi 5 (hci0=USB, hci1=built-in).
# Identifies USB dongle by MAC via hciconfig, brings it up, downs everything else.

USB_DONGLE_MAC="5C:F3:70:8B:D2:C1"

# Unblock all BT radios
/usr/sbin/rfkill unblock bluetooth 2>/dev/null || true

# Bring all adapters up so hciconfig can read their MACs
hciconfig hci0 up 2>/dev/null || true
hciconfig hci1 up 2>/dev/null || true
sleep 2

# Find which hci# is the USB dongle using hciconfig
USB_HCI=$(hciconfig -a | awk -v mac="$USB_DONGLE_MAC" '
  /^hci[0-9]+:/ { cur=$1; gsub(/:$/,"",cur) }
  /BD Address:/ && $3 == mac { print cur }
')

if [ -z "$USB_HCI" ]; then
  echo "USB BT dongle ($USB_DONGLE_MAC) not found — falling back to built-in BT" >&2
  # Use whatever adapter is available (hci0 on Pi 5 = built-in)
  BT_MAC=$(hciconfig -a | awk '/BD Address:/ { print $3; exit }')
  if [ -z "$BT_MAC" ]; then
    echo "No BT adapter found at all!" >&2
    exit 1
  fi
  echo "Using built-in BT adapter ($BT_MAC)"
else
  echo "Found USB dongle at $USB_HCI"
  BT_MAC="$USB_DONGLE_MAC"

  # Down all adapters except the USB dongle
  for i in 0 1; do
    [ "hci$i" != "$USB_HCI" ] && hciconfig "hci$i" down 2>/dev/null || true
  done
fi

sleep 2

bluetoothctl << BTEOF
select $BT_MAC
power on
system-alias SilentDisco
discoverable on
pairable on
BTEOF
