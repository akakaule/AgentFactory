import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { getTask } from '../src/ops/getTask.js';
import { getVersion } from '../src/version.js';
import { attachVisualization, getVisualization, getVisualizationHtml } from '../src/ops/visualization.js';
import { NotFoundError } from '../src/errors.js';

describe('visualization ops', () => {
  it('returns null for an unknown / not-yet-visualized task; attach on an unknown key throws', () => {
    const db = makeTestDb();
    expect(getVisualization(db, 'AF-999')).toBeNull();
    expect(getVisualizationHtml(db, 'AF-999')).toBeNull();
    expect(() => attachVisualization(db, 'AF-999', { html: '<html></html>' })).toThrow(NotFoundError);

    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(getVisualization(db, t.key)).toBeNull();
    expect(getVisualizationHtml(db, t.key)).toBeNull();
  });

  it('attaches and reads back the HTML (gzip round-trip) with meta', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const html = '<html><body><h1>Change</h1><pre>diff…</pre></body></html>';

    const meta = attachVisualization(db, t.key, { html });
    expect(meta.bytes).toBe(html.length);

    expect(getVisualizationHtml(db, t.key)).toBe(html);
    expect(getVisualization(db, t.key)).toMatchObject({ bytes: html.length });
    expect(getVisualization(db, t.key)!.generatedAt).toBeTruthy();
  });

  it('re-attaching replaces the HTML and keeps a single row', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    attachVisualization(db, t.key, { html: '<p>one</p>' });
    attachVisualization(db, t.key, { html: '<p>two</p>' });

    expect(getVisualizationHtml(db, t.key)).toBe('<p>two</p>');
    const { c } = db.prepare('SELECT COUNT(*) c FROM task_visualization').get() as { c: number };
    expect(c).toBe(1);
  });

  it('toDetail exposes hasVisualization + generatedAt', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(getTask(db, t.key)).toMatchObject({ hasVisualization: false, visualizationGeneratedAt: null });

    attachVisualization(db, t.key, { html: '<p>x</p>' }, () => '2099-01-01T00:00:00.000Z');
    const detail = getTask(db, t.key);
    expect(detail.hasVisualization).toBe(true);
    expect(detail.visualizationGeneratedAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it('is folded into getVersion so an attach bumps the board version', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const before = getVersion(db);

    attachVisualization(db, t.key, { html: '<p>x</p>' }, () => '2099-01-01T00:00:00.000Z');
    const after = getVersion(db);

    expect(after).not.toBe(before);
    expect(after.startsWith('2099-01-01T00:00:00.000Z')).toBe(true);
  });
});
