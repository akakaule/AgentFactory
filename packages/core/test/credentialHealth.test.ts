import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { updateWorkspace } from '../src/ops/updateWorkspace.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import {
  clearCredentialHealth, getCredentialRecord, listCredentialHealth, recordCredentialCheck,
} from '../src/credentialHealth.js';

const at = (iso: string) => () => iso;
const T0 = '2026-10-30T13:50:00.000Z';
const T1 = '2026-10-30T14:05:00.000Z';
const T2 = '2026-10-30T14:20:00.000Z';

describe('credential health', () => {
  it('records a check and derives its state on read', () => {
    const db = makeTestDb();
    recordCredentialCheck(db, 'default', { status: 'ok', error: null, expiresAt: null }, at(T0));

    expect(getCredentialRecord(db, 'default')).toEqual({ status: 'ok', error: null, expiresAt: null, checkedAt: T0, failingSince: null });
    expect(listCredentialHealth(db, at(T0))).toEqual([{
      workspace: 'default', state: 'ok', status: 'ok', checkedAt: T0, failingSince: null, error: null, expiresAt: null, expiresInDays: null,
    }]);
  });

  it('keeps failingSince across repeated failures and clears it once the credential works again', () => {
    const db = makeTestDb();
    recordCredentialCheck(db, 'default', { status: 'failing', error: 'fatal: Authentication failed', expiresAt: null }, at(T0));
    recordCredentialCheck(db, 'default', { status: 'failing', error: 'fatal: Authentication failed', expiresAt: null }, at(T1));
    expect(getCredentialRecord(db, 'default')).toMatchObject({ status: 'failing', checkedAt: T1, failingSince: T0 });

    recordCredentialCheck(db, 'default', { status: 'ok', error: null, expiresAt: null }, at(T2));
    expect(getCredentialRecord(db, 'default')).toMatchObject({ status: 'ok', checkedAt: T2, failingSince: null, error: null });
  });

  it('does not let an unreachable check clear a known failure', () => {
    const db = makeTestDb();
    recordCredentialCheck(db, 'default', { status: 'failing', error: 'fatal: Authentication failed', expiresAt: null }, at(T0));
    recordCredentialCheck(db, 'default', { status: 'unreachable', error: 'Could not resolve host', expiresAt: null }, at(T1));
    expect(getCredentialRecord(db, 'default')).toMatchObject({ status: 'failing', checkedAt: T1, failingSince: T0, error: 'Could not resolve host' });

    clearCredentialHealth(db, 'default');
    recordCredentialCheck(db, 'default', { status: 'unreachable', error: 'timed out', expiresAt: null }, at(T2));
    expect(getCredentialRecord(db, 'default')).toMatchObject({ status: 'unreachable', failingSince: null });
  });

  it('reads expiring within 7 days and counts the days left', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'later', repoPath: '/later' });
    recordCredentialCheck(db, 'default', { status: 'ok', error: null, expiresAt: '2026-11-04T12:00:00.000Z' }, at(T0));
    recordCredentialCheck(db, 'later', { status: 'ok', error: null, expiresAt: '2026-11-27T12:00:00.000Z' }, at(T0));

    const views = Object.fromEntries(listCredentialHealth(db, at(T0)).map((v) => [v.workspace, v]));
    expect(views.default).toMatchObject({ state: 'expiring', expiresInDays: 5 });
    expect(views.later).toMatchObject({ state: 'ok', expiresInDays: 28 });
    expect(listCredentialHealth(db, at('2026-11-05T00:00:00.000Z')).find((v) => v.workspace === 'default'))
      .toMatchObject({ state: 'expiring', expiresInDays: 0 });
  });

  it('drops records of workspaces that no longer exist', () => {
    const db = makeTestDb();
    recordCredentialCheck(db, 'gone', { status: 'failing', error: 'x', expiresAt: null }, at(T0));
    expect(listCredentialHealth(db, at(T0))).toEqual([]);
  });

  it('forgets the record when the workspace PAT changes', () => {
    const db = makeTestDb();
    recordCredentialCheck(db, 'default', { status: 'failing', error: 'x', expiresAt: null }, at(T0));
    updateWorkspace(db, 'default', { policy: 'be careful' });
    expect(getCredentialRecord(db, 'default')).not.toBeNull(); // unrelated edit keeps it
    updateWorkspace(db, 'default', { pat: 'new-pat' });
    expect(getCredentialRecord(db, 'default')).toBeNull();
  });
});

describe('credential hold', () => {
  function queued(workspace: string | undefined, stage: 'implementation' | 'description' = 'implementation') {
    const task = createTask(db, { title: `T ${workspace ?? 'default'} ${stage}`, spec: 'S', acceptanceCriteria: 'A', stage, ...(workspace ? { workspace } : {}) });
    updateStatus(db, task.key, 'queued', 'human');
    return task;
  }
  let db: ReturnType<typeof makeTestDb>;

  it('skips queued implementation work in a workspace whose PAT is failing, and resumes once it works', () => {
    db = makeTestDb();
    createWorkspace(db, { name: 'other', repoPath: '/other' });
    const heldImpl = queued(undefined);
    const spec = queued(undefined, 'description');
    const elsewhere = queued('other');
    recordCredentialCheck(db, 'default', { status: 'failing', error: 'fatal: Authentication failed', expiresAt: null });

    const rows = Object.fromEntries(listTasks(db).map((t) => [t.key, t]));
    expect(rows[heldImpl.key]!.credentialHold).toBe(true);
    expect(rows[spec.key]!.credentialHold).toBe(false);
    expect(rows[elsewhere.key]!.credentialHold).toBe(false);

    const claimed = [claimNextTask(db, {})?.key, claimNextTask(db, {})?.key, claimNextTask(db, {})?.key];
    expect(claimed).toEqual([spec.key, elsewhere.key, undefined]);

    recordCredentialCheck(db, 'default', { status: 'ok', error: null, expiresAt: null });
    expect(claimNextTask(db, {})?.key).toBe(heldImpl.key);
  });

  it('does not hold on an unreachable check', () => {
    db = makeTestDb();
    const task = queued(undefined);
    recordCredentialCheck(db, 'default', { status: 'unreachable', error: 'timed out', expiresAt: null });
    expect(claimNextTask(db, {})?.key).toBe(task.key);
  });
});
