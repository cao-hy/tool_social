import { z } from 'zod';

export const registerSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase().trim()),
  password: z.string().min(6),
  name: z.string().trim().min(1).max(120).optional(),
  workspaceName: z.string().trim().min(1).max(120).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase().trim()),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase().trim()),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(32),
  password: z.string().min(6),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
