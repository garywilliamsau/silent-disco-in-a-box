'use strict';

const { execSync, exec } = require('child_process');

// Track BT device → channel assignments
// { mac: { name, channel, connectedAt } }
const assignments = new Map();

// Auto-assign order: Blue first, then Green, then Red
const ASSIGN_ORDER = ['blue', 'green', 'red'];

function getConnectedDevices() {
  try {
    const output = execSync('bluetoothctl devices Connected 2>/dev/null', {
      encoding: 'utf8',
      timeout: 3000,
    });
    const devices = [];
    for (const line of output.trim().split('\n')) {
      const match = line.match(/^Device\s+([0-9A-F:]+)\s+(.+)$/i);
      if (match) {
        devices.push({ mac: match[1], name: match[2] });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

function getPairedDevices() {
  try {
    const output = execSync('bluetoothctl devices Paired 2>/dev/null', {
      encoding: 'utf8',
      timeout: 3000,
    });
    const devices = [];
    for (const line of output.trim().split('\n')) {
      const match = line.match(/^Device\s+([0-9A-F:]+)\s+(.+)$/i);
      if (match) {
        devices.push({ mac: match[1], name: match[2] });
      }
    }
    return devices;
  } catch {
    return [];
  }
}

function getNextFreeChannel(channels) {
  const usedChannels = new Set([...assignments.values()].map(a => a.channel));
  for (const ch of ASSIGN_ORDER) {
    if (channels.includes(ch) && !usedChannels.has(ch)) return ch;
  }
  return null;
}

function autoAssign(channels) {
  const connected = getConnectedDevices();
  const connectedMacs = new Set(connected.map(d => d.mac));

  // Remove assignments for disconnected devices
  for (const [mac, info] of assignments) {
    if (!connectedMacs.has(mac)) {
      assignments.delete(mac);
    }
  }

  // Auto-assign new devices
  for (const device of connected) {
    if (!assignments.has(device.mac)) {
      const channel = getNextFreeChannel(channels);
      if (channel) {
        assignments.set(device.mac, {
          name: device.name,
          channel,
          connectedAt: Date.now(),
        });
      }
    }
  }

  return getStatus();
}

function assignToChannel(mac, channel) {
  const existing = assignments.get(mac);
  if (!existing) return false;

  // Unassign any device currently on the target channel
  for (const [otherMac, info] of assignments) {
    if (info.channel === channel && otherMac !== mac) {
      info.channel = null;
    }
  }

  existing.channel = channel;
  return true;
}

function getStatus() {
  const connected = getConnectedDevices();
  const devices = connected.map(d => {
    const assignment = assignments.get(d.mac);
    return {
      mac: d.mac,
      name: d.name,
      channel: assignment?.channel || null,
    };
  });

  return { devices };
}

function getChannelBtDevice(channel) {
  for (const [mac, info] of assignments) {
    if (info.channel === channel) return { mac, name: info.name };
  }
  return null;
}

function getNowPlaying() {
  try {
    const output = execSync(
      'bluetoothctl player.show 2>/dev/null',
      { encoding: 'utf8', timeout: 3000 }
    );
    const result = { title: '', artist: '', album: '', status: '' };
    for (const line of output.split('\n')) {
      const m = line.match(/^\s+Track\.Title:\s+(.+)$/);
      if (m) result.title = m[1];
      const a = line.match(/^\s+Track\.Artist:\s+(.+)$/);
      if (a) result.artist = a[1];
      const al = line.match(/^\s+Track\.Album:\s+(.+)$/);
      if (al) result.album = al[1];
      const s = line.match(/^\s+Status:\s+(.+)$/);
      if (s) result.status = s[1];
    }
    return result.title ? result : null;
  } catch {
    return null;
  }
}

function removePairedDevice(mac) {
  try {
    execSync(`bluetoothctl remove ${mac} 2>/dev/null`, { timeout: 5000 });
    assignments.delete(mac);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getConnectedDevices,
  getPairedDevices,
  autoAssign,
  assignToChannel,
  getStatus,
  getChannelBtDevice,
  getNowPlaying,
  removePairedDevice,
};
