import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const inviteMemberSchema = z.object({
  email: z
    .string()
    .email()
    .transform((value) => value.toLowerCase().trim()),
  role: z.enum(['ADMIN', 'EDITOR', 'ANALYST', 'VIEWER']).default('VIEWER'),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(32),
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(['ADMIN', 'EDITOR', 'ANALYST', 'VIEWER']),
});

export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
