import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const DATABASE_URL = 'postgres://u:p@localhost:5432/db';

describe('loadConfig', () => {
  it('applies defaults when only DATABASE_URL is set', () => {
    expect(loadConfig({ DATABASE_URL })).toEqual({
      host: '127.0.0.1',
      port: 3000,
      databaseUrl: DATABASE_URL,
      logLevel: 'info',
    });
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it.each(['abc', '-1', '70000', '3.5'])('rejects PORT=%s', (port) => {
    expect(() => loadConfig({ DATABASE_URL, PORT: port })).toThrow(/PORT/);
  });
});
