/// <reference types="node" />
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

/**
 * Admin bootstrap.
 *
 * Security rules:
 *  - Credentials are NEVER hardcoded. They come from ADMIN_EMAIL / ADMIN_PASSWORD env vars.
 *  - The admin account is only CREATED when it does not exist. An existing account's password
 *    is never rewritten by a deploy (previously every deploy reset it to a known default).
 *  - If ADMIN_PASSWORD is not provided but ADMIN_EMAIL is, a random password is generated once,
 *    printed to stdout ONCE, and never stored anywhere else.
 *  - If neither is provided the step is skipped. Promote a user manually with:
 *      UPDATE users SET role = 'admin' WHERE email = '...';
 */
async function seedAdmin(): Promise<void> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const providedPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail) {
    console.log('ℹ ADMIN_EMAIL not set — skipping admin bootstrap.');
    return;
  }

  const existing = await prisma.user.findFirst({ where: { email: adminEmail } });
  if (existing) {
    if (existing.role !== 'admin') {
      await prisma.user.update({ where: { id: existing.id }, data: { role: 'admin' } });
      console.log(`✓ Promoted existing user ${adminEmail} to admin (password untouched).`);
    } else {
      console.log(`✓ Admin ${adminEmail} already exists — nothing to do.`);
    }
    return;
  }

  if (providedPassword && providedPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  }

  const password = providedPassword ?? crypto.randomBytes(18).toString('base64url');
  const hashedPassword = await bcrypt.hash(password, 12);

  await prisma.user.create({
    data: {
      email: adminEmail,
      hashedPassword,
      role: 'admin',
      dataConsent: true,
      dataConsentDate: new Date(),
      expertiseLevel: 'expert',
    },
  });

  if (providedPassword) {
    console.log(`✓ Admin account created: ${adminEmail}`);
  } else {
    console.log(`✓ Admin account created: ${adminEmail}`);
    console.log(`   Generated one-time password (store it now, it will not be shown again):`);
    console.log(`   ${password}`);
  }
}

/**
 * Model routes are seeded ONLY when missing. Existing rows are never overwritten so that
 * operator changes made through the model_routes table survive deploys.
 */
async function seedModelRoutes(): Promise<void> {
  console.log('Seeding default model routes (Cases A-F, M) where missing...');

  const initialRoutes = [
    { taskCase: 'M', domain: null, modelProvider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.0, maxTokens: 500, isActive: true },
    { taskCase: 'B', domain: null, modelProvider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.1, maxTokens: 2048, isActive: true },
    { taskCase: 'E', domain: null, modelProvider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.3, maxTokens: 1024, isActive: true },
    { taskCase: 'A', domain: null, modelProvider: 'openai', modelName: 'gpt-4o', temperature: 0.2, maxTokens: 8192, isActive: true },
    { taskCase: 'C', domain: null, modelProvider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.0, maxTokens: 2048, isActive: true },
    { taskCase: 'D', domain: null, modelProvider: 'openai', modelName: 'gpt-4o', temperature: 0.4, maxTokens: 4096, isActive: true },
    { taskCase: 'F', domain: null, modelProvider: 'openai', modelName: 'gpt-4o-mini', temperature: 0.1, maxTokens: 4096, isActive: true },
  ];

  for (const route of initialRoutes) {
    const existing = await prisma.modelRoute.findFirst({
      where: { taskCase: route.taskCase, domain: route.domain },
    });

    if (!existing) {
      await prisma.modelRoute.create({ data: route });
      console.log(`✓ Seeded route ${route.taskCase} -> ${route.modelProvider}/${route.modelName}`);
    } else {
      console.log(`· Route ${route.taskCase} exists (${existing.modelProvider}/${existing.modelName}) — left unchanged.`);
    }
  }
}

async function main() {
  await seedAdmin();
  await seedModelRoutes();
  console.log('Seed completed.');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
