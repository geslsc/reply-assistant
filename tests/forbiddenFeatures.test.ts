import { EventType, ThreadState } from '../src/types';
import * as fs from 'fs';
import * as path from 'path';

describe('Forbidden Features Reverse Tests', () => {
  it('does not include Notion client or live query code', () => {
    const srcDir = path.join(__dirname, '../src');
    const files = walk(srcDir);
    const joined = files
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');

    expect(joined).not.toMatch(/@notionhq\/client/);
    expect(joined).not.toMatch(/notion\.databases\.query/);
  });

  it('does not include scheduler timeout push', () => {
    const srcDir = path.join(__dirname, '../src');
    const joined = walk(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    expect(joined).not.toMatch(/node-cron/);
    expect(joined).not.toMatch(/setInterval\(.*timeout/i);
  });

  it('still uses only 5 thread states and 10 event types', () => {
    expect(Object.values(ThreadState).length).toBe(5);
    expect(Object.values(EventType).length).toBe(10);
  });
});

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
