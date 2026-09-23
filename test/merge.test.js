'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

// main.js starts with `require('obsidian')`; serve the stub instead so the
// pure merge helpers can be loaded under plain Node.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return require(path.join(__dirname, 'obsidian-stub.js'));
  return origLoad.apply(this, arguments);
};

const { threeWayMerge, diffLineOps, unionLines, mergeUnknownBase } = require('../main.js');

function applyOps(base, ops) {
  const out = [];
  let i = 0;
  for (const op of ops) {
    if (op.t === 'eq') {
      for (let k = 0; k < op.len; k++) out.push(base[i++]);
    } else {
      i = op.de;
      out.push(...op.ins);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// diffLineOps
// ---------------------------------------------------------------------------

test('diffLineOps reconstructs the target for several edits', () => {
  const cases = [
    [['a', 'b', 'c'], ['a', 'b', 'c']],
    [['a', 'b', 'c'], ['a', 'x', 'c']],
    [['a', 'b', 'c'], ['a', 'c']],
    [['a', 'b', 'c'], ['a', 'b', 'c', 'd']],
    [['a', 'b', 'c'], ['x', 'a', 'b', 'c']],
    [[], ['a', 'b']],
    [['a', 'b'], []],
  ];
  for (const [base, target] of cases) {
    const ops = diffLineOps(base, target);
    assert.ok(ops, 'ops should not be null for small inputs');
    assert.deepEqual(applyOps(base, ops), target);
  }
});

// ---------------------------------------------------------------------------
// unionLines
// ---------------------------------------------------------------------------

test('unionLines appends local-only lines and skips blanks', () => {
  assert.equal(unionLines('a\nb\n', 'a\nb\nc\n'), 'a\nb\nc\n');
  assert.equal(unionLines('a\n', 'a\n'), 'a\n');
  assert.equal(unionLines('a\n', 'b\n'), 'a\nb\n');
  assert.equal(unionLines('a\n', 'a\n\n\n'), 'a\n');
});

// ---------------------------------------------------------------------------
// threeWayMerge
// ---------------------------------------------------------------------------

test('threeWayMerge is idempotent when both sides agree', () => {
  const base = 'line1\nline2\n';
  const same = 'line1\nCHANGED\nline3\n';
  assert.equal(threeWayMerge(base, same, same), same);
});

test('threeWayMerge applies a one-sided edit', () => {
  const base = 'a\nb\n';
  const local = 'a\nB\n';
  assert.equal(threeWayMerge(base, local, base), local);
  assert.equal(threeWayMerge(base, base, local), local);
});

test('threeWayMerge is order-independent for concurrent insertions', () => {
  const base = 'x\n';
  const local = 'x\na\n';
  const remote = 'x\nb\n';
  const ab = threeWayMerge(base, local, remote);
  const ba = threeWayMerge(base, remote, local);
  assert.equal(ab, ba, 'both sides must converge to the same text');
  assert.match(ab, /(^|\n)a(\n|$)/);
  assert.match(ab, /(^|\n)b(\n|$)/);
  assert.equal(threeWayMerge(base, ab, ab), ab, 'merge result must be stable');
});

test('threeWayMerge keeps both concurrent edits of the same line', () => {
  const base = 'b\n';
  const local = 'L\n';
  const remote = 'R\n';
  const merged = threeWayMerge(base, local, remote);
  assert.match(merged, /(^|\n)L(\n|$)/);
  assert.match(merged, /(^|\n)R(\n|$)/);
  assert.equal(merged, threeWayMerge(base, remote, local));
});

test('threeWayMerge drops a line deleted on one side', () => {
  const base = 'keep\ndelete\nkeep2\n';
  const local = 'keep\nkeep2\n';
  const merged = threeWayMerge(base, local, base);
  assert.equal(merged, local);
  assert.ok(!merged.includes('delete'));
});

// ---------------------------------------------------------------------------
// mergeUnknownBase
// ---------------------------------------------------------------------------

test('mergeUnknownBase never loses lines', () => {
  const remote = 'a\nb\n';
  const local = 'a\nb\nc\n';
  const merged = mergeUnknownBase(remote, local);
  assert.ok(merged.includes('c'));
  assert.ok(merged.includes('a'));
  assert.ok(merged.includes('b'));
  assert.equal(mergeUnknownBase(remote, remote), remote);
});
