'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.DISCO_CONFIG
  || path.join(__dirname, '..', '..', 'config', 'disco.conf');

let config = null;

function load() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  config = JSON.parse(raw);
  return config;
}

function get() {
  if (!config) load();
  return config;
}

module.exports = { load, get };
