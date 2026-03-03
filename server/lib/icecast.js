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

  return {
    totalClients: icestats.clients || 0,
    totalSources: icestats.sources || 0,
    channels: byMount,
  };
}

module.exports = { fetchStats, getChannelStats };
