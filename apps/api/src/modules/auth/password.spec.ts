import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing — SECURITY.md §3', () => {
  it('hash mật khẩu bằng Argon2id', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain('correct horse battery staple');
  });

  it('verify đúng mật khẩu và từ chối mật khẩu sai', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong horse battery staple', hash)).resolves.toBe(false);
  });

  it('từ chối hash không phải Argon2id', async () => {
    await expect(verifyPassword('password', 'scrypt:v1:salt:hash')).resolves.toBe(false);
  });

  it('mật khẩu tối thiểu 12 ký tự', async () => {
    await expect(hashPassword('short')).rejects.toThrow('ít nhất 6 ký tự');
  });
});
