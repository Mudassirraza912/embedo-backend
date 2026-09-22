import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters long').max(72, 'Password cannot exceed 72 characters'),
  expertiseLevel: z.enum(['student', 'hobbyist', 'professional', 'expert']).optional(),
  dataConsent: z.literal(true, {
    errorMap: () => ({ message: 'Data consent is required to register and use Embedo' }),
  }),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required').max(72),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().max(255).optional(), // Can come from cookie or body
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'Google ID Token is required'),
  expertiseLevel: z.enum(['student', 'hobbyist', 'professional', 'expert']).optional(),
  // Required (true) when this sign-in creates a NEW account; ignored for existing accounts.
  dataConsent: z.boolean().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters long').max(72, 'Password cannot exceed 72 characters'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

