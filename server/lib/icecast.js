'use strict';

const http = require('http');

function fetchStats() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: 8000, path: '/status-json.xsl' },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Failed to parse Icecast stats: ' + e.message));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Icecast stats timeout')));
  });
}

// Fetch external listener count for a single mount via the admin listclients API.
// Filters out 127.0.0.1 connections (energy analyser's ffmpeg, Liquidsoap monitors, etc.).
function fetchExternalListeners(mount) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: 8000,
        path: `/admin/listclients?mount=${encodeURIComponent(mount)}`,
        auth: 'admin:adminpass',
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          // Count <IP> tags that are not 127.0.0.1
          const ips = [...body.matchAll(/<IP>([^<]+)<\/IP>/g)].map(m => m[1]);
          const external = ips.filter(ip => ip !== '127.0.0.1').length;
          resolve(external);
        });
      }
    );
    req.on('error', () => resolve(null)); // null = fall back to stats count
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

async function getChannelStats() {
  const data = await fetchStats();
  const icestats = data.icestats || {};

  let sources = icestats.source || [];
  if (!Array.isArray(sources)) sources = [sources];

  const byMount = {};
  for (const src of sources) {
    const url = src.listenurl || '';
    const mount = '/' + url.split('/').pop();
    byMount[mount] = {
      mount,
      listeners: src.listeners || 0,
      title: src.title || '',
      artist: src.artist || '',
    };
  }

  // Fetch accurate external-only listener counts in parallel
  const mounts = Object.keys(byMount);
  const externalCounts = await Promise.all(mounts.map(m => fetchExternalListeners(m)));
  for (let i = 0; i < mounts.length; i++) {
    const count = externalCounts[i];
    if (count !== null) byMount[mounts[i]].listeners = count;
  }

  return {
    totalClients: icestats.clients || 0,
    totalSources: icestats.sources || 0,
    channels: byMount,
  };
}

module.exports = { fetchStats, getChannelStats };
