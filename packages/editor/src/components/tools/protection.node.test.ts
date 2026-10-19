import { createPdfEngine } from '@folio/pdf-core';
import { fakeDocumentInfo } from '@folio/pdf-core/testing';
import { memoryFile } from '@folio/platform-adapters';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_PASSWORD,
  nodeWorkerSrc,
  readFixture,
  type FixtureName,
} from '../../../../../tests/setup/fixtures';
import { createWorkspaceStore } from '../../store/workspace';
import {
  canRemoveProtection,
  describeProtection,
  passwordStrength,
  restrictionsOf,
  verifyProtection,
} from './protection';

const engine = createPdfEngine({ workerSrc: nodeWorkerSrc(), assetBaseUrl: null });
afterAll(() => engine.destroy());

const ALLOWED = {
  print: true,
  copy: true,
  modify: true,
  annotate: true,
  fillForms: true,
  assemble: true,
};
const RESTRICTED = { ...ALLOWED, print: false, copy: false, modify: false };

async function openFixture(name: FixtureName, password?: string) {
  const store = createWorkspaceStore(engine);
  await store.getState().openFiles([memoryFile(name, readFixture(name))]);
  const key = store.getState().documents[0]!.key;
  if (password !== undefined) await store.getState().submitPassword(key, password);
  return { store, key };
}

describe('password protection', () => {
  it('describes how a document is protected and what it restricts', () => {
    expect(describeProtection(fakeDocumentInfo())).toBe('This document is not protected.');
    expect(
      describeProtection(
        fakeDocumentInfo({ encryption: 'password-protected', permissions: ALLOWED }),
      ),
    ).toBe('This document needs a password to open.');
    expect(
      describeProtection(
        fakeDocumentInfo({ encryption: 'owner-restricted', permissions: RESTRICTED }),
      ),
    ).toBe(
      'This document opens without a password, but does not allow printing, copying text and images, changing the document.',
    );
    expect(restrictionsOf(null)).toEqual([]);
    expect(restrictionsOf(RESTRICTED)).toEqual(['print', 'copy', 'modify']);
  });

  it('removes only protection the user unlocked and that restricts nothing', () => {
    expect(
      canRemoveProtection(
        fakeDocumentInfo({ encryption: 'password-protected', permissions: ALLOWED }),
      ),
    ).toBe(true);
    expect(
      canRemoveProtection(
        fakeDocumentInfo({ encryption: 'password-protected', permissions: RESTRICTED }),
      ),
    ).toBe(false);
    expect(
      canRemoveProtection(
        fakeDocumentInfo({ encryption: 'owner-restricted', permissions: RESTRICTED }),
      ),
    ).toBe(false);
    expect(canRemoveProtection(fakeDocumentInfo())).toBe(false);
  });

  it('says how strong a password is, plainly', () => {
    expect(passwordStrength('')).toBeNull();
    expect(passwordStrength('abc123')?.level).toBe('weak');
    expect(passwordStrength('lighthouse')?.level).toBe('fair');
    expect(passwordStrength('Lighthouse7')?.level).toBe('strong');
    expect(passwordStrength('lighthouse keeper')?.level).toBe('strong');
    expect(passwordStrength('Ünïcödé')?.level).toBe('weak');
  });

  it('confirms a copy is protected as chosen before it is saved', async () => {
    const { store, key } = await openFixture('basic-3-pages.pdf');
    const protection = { userPassword: 'open sesame', permissions: RESTRICTED };
    const { bytes } = await store.getState().exportDocument(key, { protection });
    const expected = { password: 'open sesame', permissions: RESTRICTED, pageCount: 3 };
    expect(await verifyProtection(engine, bytes, expected)).toBe(true);
    // Anything else is caught: another password, other permissions, other pages.
    expect(await verifyProtection(engine, bytes, { ...expected, password: 'other' })).toBe(false);
    expect(await verifyProtection(engine, bytes, { ...expected, permissions: ALLOWED })).toBe(
      false,
    );
    expect(await verifyProtection(engine, bytes, { ...expected, pageCount: 2 })).toBe(false);
    expect(await verifyProtection(engine, bytes, { ...expected, permissions: null })).toBe(false);
    // A copy that opens without the password is not protected.
    const plain = (await store.getState().exportDocument(key)).bytes;
    expect(await verifyProtection(engine, plain, expected)).toBe(false);
    expect(await verifyProtection(engine, new Uint8Array([1, 2, 3]), expected)).toBe(false);
    await store.getState().close(key);
  });

  it('writes copies with chosen protection, none, or the original’s', async () => {
    const { store, key } = await openFixture('encrypted-user-password.pdf', FIXTURE_PASSWORD);
    // By default a copy keeps the password it was opened with.
    const kept = (await store.getState().exportDocument(key)).bytes;
    expect(
      await verifyProtection(engine, kept, {
        password: FIXTURE_PASSWORD,
        permissions: ALLOWED,
        pageCount: 3,
      }),
    ).toBe(true);
    const removed = (await store.getState().exportDocument(key, { protection: 'none' })).bytes;
    expect(
      await verifyProtection(engine, removed, { password: '', permissions: null, pageCount: 3 }),
    ).toBe(true);
    const changed = (
      await store.getState().exportDocument(key, {
        protection: { userPassword: 'new one', permissions: null },
      })
    ).bytes;
    expect(
      await verifyProtection(engine, changed, {
        password: 'new one',
        permissions: ALLOWED,
        pageCount: 3,
      }),
    ).toBe(true);
    await expect(engine.open(changed, { password: FIXTURE_PASSWORD })).rejects.toThrow();
    // The document itself did not change.
    expect(store.getState().documents[0]!.editor!.history.past).toHaveLength(0);
    await store.getState().close(key);
  });
});
