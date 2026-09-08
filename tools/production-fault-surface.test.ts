import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const candidate = path.join(root, entry);
    return statSync(candidate).isDirectory()
      ? sourceFiles(candidate)
      : /\.(?:ts|tsx)$/.test(candidate)
        ? [candidate]
        : [];
  });
}

describe('production fault surface', () => {
  it('does not import the fault laboratory into a production application', () => {
    const apps = new URL('../apps', import.meta.url).pathname;
    const imports = sourceFiles(apps)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => source.includes('@capitaldesk/fault-lab'));
    expect(imports).toEqual([]);
  });
});
