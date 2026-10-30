import bcrypt from 'bcryptjs';
import type { SessionUser } from '~/context';
import { db } from '~/db.server';

export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email }, include: { password: true } });
  if (!user?.password) return null;
  const matches = await bcrypt.compare(password, user.password.hash);
  if (!matches) return null;
  return { id: user.id, email: user.email, name: user.name };
}
