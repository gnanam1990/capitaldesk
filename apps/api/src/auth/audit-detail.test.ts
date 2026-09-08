import { describe, expect, it } from 'vitest';
import { REJECTED_COUNT_FIELD, sanitizeAuditDetail } from './audit-detail.js';

describe('audit detail schema', () => {
  it('keeps the identifiers an operator needs to read the trail', () => {
    const { detail, rejectedKeys } = sanitizeAuditDetail({
      credentialId: 'cred-AbCdEfGhI',
      rotatedFrom: 'cred-ZyXwVuTsR',
      loginName: 'desk.owner',
      capability: 'credential.rotate',
      refusal: 'WRONG_CODE',
    });
    expect(rejectedKeys).toEqual([]);
    expect(detail).toEqual({
      credentialId: 'cred-AbCdEfGhI',
      rotatedFrom: 'cred-ZyXwVuTsR',
      loginName: 'desk.owner',
      capability: 'credential.rotate',
      refusal: 'WRONG_CODE',
    });
  });

  it('drops a secret whatever key it arrives under, and records only the key name', () => {
    // Each of these defeats a value-shape scrubber on its own: none matches a known secret
    // pattern. What refuses them is the schema.
    const secrets = {
      token: 'cdk_local_cred-AbCdEfGhI_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_A',
      password: 'correct-horse-battery-staple-7',
      signedUrl: 'https://venue.test/order?signature=deadbeefcafe&timestamp=1',
      secret_hash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
    };
    const { detail, rejectedKeys } = sanitizeAuditDetail(secrets);

    expect([...rejectedKeys].sort()).toEqual(['password', 'secret_hash', 'signedUrl', 'token']);
    const serialized = JSON.stringify(detail);
    for (const value of Object.values(secrets)) expect(serialized).not.toContain(value);
    expect(detail[REJECTED_COUNT_FIELD]).toBe('4');
  });

  it('never writes a rejected key name, because keys are caller-controlled too', () => {
    // A secret passed as a *key* would have been persisted verbatim in the rejected-keys
    // list, which is the leak the schema exists to prevent, arriving through the other half
    // of the object.
    const secretKey = 'cdk_local_cred-AbCdEfGhI_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_A';
    const { detail, rejectedKeys } = sanitizeAuditDetail({
      [secretKey]: 'x',
      'another-secret-key': 'y',
    });
    expect(rejectedKeys).toEqual([secretKey, 'another-secret-key']);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain('another-secret-key');
    expect(detail).toEqual({ [REJECTED_COUNT_FIELD]: '2' });
  });

  it('refuses every secret under every permitted key', () => {
    // The schema is the boundary, so the claim worth proving is exhaustive: no combination of
    // a permitted key and a secret value produces a stored value.
    const permitted = [
      'credentialId',
      'rotatedFrom',
      'enrollmentId',
      'supersededEnrollmentId',
      'supersededReason',
      'userId',
      'loginName',
      'capability',
      'refusal',
      'reason',
    ];
    const secrets = [
      'cdk_local_cred-AbCdEfGhI_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_A',
      'Tr0ub4dor&3 correct horse',
      'https://venue.test/order?signature=deadbeefcafe&timestamp=1',
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE',
    ];

    for (const key of permitted) {
      for (const secret of secrets) {
        const { detail, rejectedKeys } = sanitizeAuditDetail({ [key]: secret });
        expect(rejectedKeys, `${key} accepted ${secret}`).toEqual([key]);
        expect(JSON.stringify(detail)).not.toContain(secret);
      }
    }
  });

  it('drops nulls rather than recording an absence as a value', () => {
    expect(sanitizeAuditDetail({ supersededReason: null, credentialId: null })).toEqual({
      detail: {},
      rejectedKeys: [],
    });
  });

  it('cannot tell a lowercase passphrase from a login name, and does not pretend to', () => {
    // A known limitation, recorded rather than papered over. `desk.owner` and
    // `correct-horse-battery-staple` have the same shape, so no regex can separate a login
    // name from a passphrase that looks like one. What keeps a password out of this column is
    // the call site: `AuditDetail`'s key union means a caller must deliberately name a value
    // `loginName`, and the only code that does holds a login name. The schema stops the
    // encodings this system mints; it does not stop a caller lying about what it is passing.
    const { detail, rejectedKeys } = sanitizeAuditDetail({
      loginName: 'correct-horse-battery-staple-7',
    });
    expect(rejectedKeys).toEqual([]);
    expect(detail['loginName']).toBe('correct-horse-battery-staple-7');
  });

  it('names the schema as the boundary, not the scrubber', () => {
    // `redactText` runs behind the schema as defence in depth. No permitted shape currently
    // admits a value it would alter, so this records the arrangement rather than pretending
    // the scrubber is what stops a secret today.
    const { detail } = sanitizeAuditDetail({ reason: 'owner revoked' });
    expect(detail['reason']).toBe('owner revoked');
  });
});
