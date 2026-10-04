'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let current = LEVELS.info;

function setLevel(name) {
  if (LEVELS[name] !== undefined) {
    current = LEVELS[name];
  }
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function stamp() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function write(level, args) {
  if (LEVELS[level] > current) return;
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${stamp()}] [${level.toUpperCase()}]`, ...args);
}

module.exports = {
  setLevel,
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
};
