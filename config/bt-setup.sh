#!/bin/bash
# Silent Disco - Bluetooth Setup
# Disables built-in BT (shares radio with WiFi on Pi 4/5) and configures USB dongle.
# Called by disco-bt-setup.service on boot.

# Disable built-in BT
hciconfig hci0 down 2>/dev/null || true

# Unblock USB dongle — rfkill may soft-block hci1 after hci0 is downed
/usr/sbin/rfkill unblock 1 2>/dev/null || true

# Bring up USB dongle
hciconfig hci1 up 2>/dev/null || true

# Wait for bluetoothd to register hci1
sleep 3

# Configure USB dongle as active controller
bluetoothctl << BTEOF
select 5C:F3:70:8B:D2:C1
power on
discoverable on
pairable on
BTEOF
