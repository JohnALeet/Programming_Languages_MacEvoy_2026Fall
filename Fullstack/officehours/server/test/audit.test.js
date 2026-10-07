'use strict';

// Source audits: cheap checks that read the code instead of running it.
//
// The field guide (section 9.6) warns that AI-drafted code can *look* safe --
// a $1 placeholder here, a db.query there -- while one line elsewhere splices
// input into SQL or HTML. A reviewer has to catch that by reading. These tests
// do some of the reading on every push, so the rules can't silently erode.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// Every server-side source file, wherever someone adds one later.
const serverFiles = () => {
  const skip = new Set(['node_modules', 'public', 'test', 'e2e', 'playwright-report', 'test-results']);
  const walk = (dir) =>
    fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) return skip.has(entry.name) ? [] : walk(rel);
      return entry.name.endsWith('.js') && !entry.name.endsWith('.config.js') ? [rel] : [];
    });
  return walk('.');
};

describe('SQL is always parameterized', () => {
  it('queries.js never interpolates into a query', () => {
    const literals = read('queries.js').match(/`[^`]*`/g) ?? [];
    assert.ok(literals.length >= 20, 'expected the SQL template literals');
    for (const sql of literals) {
      assert.doesNotMatch(sql, /\$\{/, `interpolation in:${sql.slice(0, 80)}`);
    }
  });

  it('every .query() call uses a named statement or a fixed literal', () => {
    // Allowed first arguments: SQL.someName, a plain '...' literal, or INIT_SQL
    // (the schema file). A template literal or concatenation fails the test.
    const allowed = /^\.query\(\s*(SQL\.\w+|'[^'\n]*'|INIT_SQL)\s*[,)]/;
    const offenders = [];
    for (const file of serverFiles()) {
      const source = read(file);
      for (const match of source.matchAll(/\.query\(/g)) {
        const call = source.slice(match.index, match.index + 200);
        if (!allowed.test(call)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${file}:${line}: ${call.split('\n')[0]}`);
        }
      }
    }
    assert.deepEqual(offenders, [], 'unparameterized queries');
  });

  it('actually found the queries it claims to check', () => {
    const calls = serverFiles().reduce((n, file) => n + (read(file).match(/\.query\(/g) ?? []).length, 0);
    assert.ok(calls >= 20, `only ${calls} .query( calls found -- is the scan looking in the right place?`);
  });
});

describe('business logic stays pure', () => {
  it('logic.js imports nothing, so it cannot reach the database or network', () => {
    assert.doesNotMatch(read('logic.js'), /require\(|import /);
  });
});

describe('the browser never parses data as HTML', () => {
  const script = read('public/app.js');
  const sinks = {
    innerHTML: /\.innerHTML\b/,
    outerHTML: /\.outerHTML\b/,
    insertAdjacentHTML: /\.insertAdjacentHTML\s*\(/,
    'document.write': /document\.write(ln)?\s*\(/,
    eval: /\beval\s*\(/,
    'new Function': /\bnew\s+Function\s*\(/,
  };

  for (const [name, pattern] of Object.entries(sinks)) {
    it(`public/app.js does not use ${name}`, () => {
      assert.doesNotMatch(script, pattern);
    });
  }

  it('index.html has no inline scripts, handlers or styles (the CSP would block them)', () => {
    const html = read('public/index.html');
    for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? []) {
      assert.match(tag, /^<script src="[^"]+"><\/script>$/, `inline script: ${tag.slice(0, 60)}`);
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'inline event handler attribute');
    assert.doesNotMatch(html, /\sstyle\s*=/i, 'inline style attribute');
    assert.doesNotMatch(html, /javascript:/i, 'javascript: URL');
  });
});
