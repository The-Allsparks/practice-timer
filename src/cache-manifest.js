export const CACHE_VERSION = 'practice-timer-v4';

const SOUNDS = ['charge', 'eight', 'seven', 'six', 'five', 'four', 'three', 'two', 'one', 'go', 'buzzers', 'pickup', 'bells', 'chime', 'whistle', 'end', 'foghorn', 'rest-notice'];

export const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/machine.js',
  './src/scheduler.js',
  './src/storage.js',
  './src/cache-manifest.js',
  './season/biobuzz-2026.json',
  './assets/sounds/practice/pack.json',
  ...SOUNDS.map((id) => `./assets/sounds/practice/${id}.wav`),
];
