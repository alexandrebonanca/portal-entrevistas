import { inEntity, S } from './settings.ts';

/**
 * Quem vê os custos internos (dólares dos fornecedores, estimativas de produção): só os administradores listados em
 * COST_VIEWERS (Definições → Vídeo, ou variável de ambiente; por omissão, o dono do portal). Os outros administradores, como
 * a conta de uma entidade parceira, veem o portal como clientes: só valores comerciais finais (créditos).
 */
export const COST_VIEWERS_DEFAULT = 'alexandrebonanca@gmail.com';
export function seesCosts(user: { role?: string; email?: string } | null | undefined): boolean {
  if (user?.role !== 'admin' || !user.email) return false;
  const list = (inEntity(null, () => S('COST_VIEWERS')) || COST_VIEWERS_DEFAULT).split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(user.email.toLowerCase());
}
