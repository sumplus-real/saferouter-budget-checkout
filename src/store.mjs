import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicJson(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temp, path);
    const dir = openSync(dirname(path), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function lockStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'writer.lock');
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error('Another writer owns this store. Verify it is stopped before clearing writer.lock.');
  }
  const path = join(directory, 'state.json');
  try {
    return {
      read: () => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { batches: {} },
      save: (state) => atomicJson(path, state),
      close: () => rmdirSync(lock),
    };
  } catch (error) {
    rmdirSync(lock);
    throw error;
  }
}
