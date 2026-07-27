import argon2 from 'argon2';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordPolicy(password: string): void {
  if (password.length < 12) {
    throw new PasswordPolicyError('Mật khẩu phải có ít nhất 12 ký tự.');
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) return false;
  if (!encoded.startsWith('$argon2id$')) return false;

  try {
    return await argon2.verify(encoded, password);
  } catch {
    return false;
  }
}
