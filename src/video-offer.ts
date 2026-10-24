import { esc } from './lib.ts';

/**
 * As duas opções de vídeo que o cliente vê. «Normal»: fotografias fixas com a voz do episódio (incluído nos planos).
 * «Premium»: animação por IA a partir das fotografias autorizadas, por orçamento em créditos (sempre o Veo Lite por baixo,
 * escolhido nas Definições; o nome do modelo e do nível não se mostram ao cliente). O fornecedor (Google) continua
 * nomeado onde a lei o exige: /privacy, termos e consentimentos.
 */
export const VIDEO_NORMAL = 'Vídeo normal (fotografias)';
export const VIDEO_PREMIUM = 'Vídeo premium (animação por IA)';
export const VIDEO_NORMAL_EN = 'Standard video (photos)';
export const VIDEO_PREMIUM_EN = 'Premium video (AI animation)';

/** Resumo do vídeo atual para quem não é administrador: sem custos, modelos nem fornecedores. */
export function videoSummary(ep: { video_lang?: string | null }, meta: any): string {
  const subs = `Legendas: ${esc(ep.video_lang ?? 'sem legendas')}`;
  if (meta?.engine === 'veo') {
    const still = meta.fallbackSegments?.length ?? 0;
    return `${subs} · ${VIDEO_PREMIUM}${still ? ` · ${still} falas com a fotografia fixa (a animação não ficou fiel ao guião ou foi recusada pelo fornecedor; essas falas não são cobradas)` : ''}${meta.paidBy === 'entity' ? ' · pago pela entidade, no projeto Google dela (sem créditos)' : ''}${meta.intro ? ' · com a introdução animada do entrevistador (oferecida)' : ''}`;
  }
  if (meta?.animatedSegments) return `${subs} · ${VIDEO_PREMIUM} · ${meta.animatedSegments} falas animadas`;
  return `${subs} · ${VIDEO_NORMAL}`;
}
