import { config } from './config.ts';
import { sha256 } from './lib.ts';
import type { Db } from './db.ts';

/**
 * Introdução animada do entrevistador pelo Google Veo, oferecida (fora do orçamento e sem créditos): abre os vídeos com
 * animação de todas as entrevistas dele, logo a seguir ao aviso inicial de IA e antes do cartão de título. Frases
 * genéricas em inglês, sem nomes de pessoas, empresas, títulos nem datas (o Veo recusa nomes de pessoas reais), escolhidas
 * de uma lista fixa: nada de texto livre. Gerada uma vez por entrevistador e reaproveitada enquanto a chave não mudar.
 */
export const INTRO_PHRASES = [
  { id: 'welcome', text: 'Hello, and welcome. Thank you for joining us for another conversation.' },
  { id: 'started', text: "Welcome, and thank you for being here. Let's get started." },
  { id: 'everyone', text: 'Hello, everyone, and welcome to a new conversation.' },
] as const;
export type IntroPhrase = typeof INTRO_PHRASES[number];
export const introPhrase = (id: unknown): IntroPhrase | null => INTRO_PHRASES.find(p => p.id === id) ?? null;
/** Tentativas pagas por geração: a 2.ª só se a 1.ª não disser a frase palavra a palavra ou falhar na Google. */
export const INTRO_MAX_ATTEMPTS = 2;
/** Segmento da introdução na linha temporal do vídeo (rodapé com o nome do entrevistador na 1.ª vez que fala). */
export const INTRO_SPAN_ID = 'host_intro';

/** Chave da introdução: fotografia original, frase, voz, nível do Veo e formato (só se gera de novo se um destes mudar). */
export const introKeyOf = (o: { photoSha: string; phrase: string; voice: string; tier: string; vertical: boolean }) =>
  sha256(`intro|${o.photoSha}|${o.voice}|${o.tier}|${o.vertical ? '9:16' : '16:9'}|${o.phrase.replace(/\s+/g, ' ').trim()}|${config.openai.mock}`);

/** Introdução pronta (verificada) desta chave, com o clipe guardado. */
export const readyIntro = (db: Db, userId: string, key: string) =>
  db.one(`SELECT h.*, a.storage_key, a.meta AS clip_meta FROM host_intros h JOIN assets a ON a.id=h.asset_id AND a.deleted_at IS NULL
    WHERE h.user_id=$1 AND h.intro_key=$2 AND h.status='ready' ORDER BY h.updated_at DESC LIMIT 1`, [userId, key]);

/**
 * Gerações deste mês (de calendário) que contam para o limite: as em curso e as que chegaram a enviar algo à Google. As
 * pedidas pelo administrador não contam, nem as que pararam antes de qualquer envio.
 */
export async function introsThisMonth(db: Db, userId: string) {
  return Number((await db.one(`SELECT count(*)::int AS n FROM host_intros WHERE user_id=$1 AND counts AND created_at >= date_trunc('month', now())
    AND (status IN ('queued','running') OR sent > 0)`, [userId])).n);
}

/** Porque é que a introdução não se pode gerar nem usar nesta entrevista (null = pode): as autorizações que o Veo exige. */
export const introBlock = (iv: { host_photo_asset_id?: string | null; host_photo_rights?: boolean; host_ai_video?: boolean }): string | null =>
  !iv.host_photo_asset_id ? 'falta a fotografia do entrevistador (em «A minha fotografia»)'
  : !iv.host_photo_rights ? 'falta confirmar o direito a usar a fotografia do entrevistador (em «Dados gerais»)'
  : !iv.host_ai_video ? 'falta a autorização do entrevistador para o Google Veo (em «Dados gerais»)'
  : null;

/**
 * Estado da introdução do entrevistador para a fotografia, a voz e o nível do Veo desta entrevista: a pronta, a em curso
 * e a última pedida (com o motivo, se falhou). A fotografia determina o formato, por isso não entra na procura.
 */
export async function introState(db: Db, iv: any, owner: { id: string; intro_phrase?: string | null }, tier: string) {
  const phrase = introPhrase(owner.intro_phrase);
  const photo = iv.host_photo_asset_id ? await db.one('SELECT sha256 FROM assets WHERE id=$1 AND deleted_at IS NULL', [iv.host_photo_asset_id]) : null;
  const voice = iv.question_voice === 'male' ? 'male' : 'female';
  const rows: any[] = phrase && photo ? await db.query(`SELECT h.*, a.deleted_at AS clip_deleted FROM host_intros h LEFT JOIN assets a ON a.id=h.asset_id
    WHERE h.user_id=$1 AND h.photo_sha=$2 AND h.phrase=$3 AND h.voice=$4 AND h.tier=$5 ORDER BY h.created_at DESC LIMIT 5`, [owner.id, photo.sha256, phrase.id, voice, tier]) : [];
  return {
    phrase, voice, tier,
    ready: rows.find(r => r.status === 'ready' && r.asset_id && !r.clip_deleted) ?? null,
    open: rows.find(r => r.status === 'queued' || r.status === 'running') ?? null,
    last: rows[0] ?? null,
    used: await introsThisMonth(db, owner.id),
  };
}
