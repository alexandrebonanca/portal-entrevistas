import { randomBytes } from 'node:crypto';

const env = process.env;
const bool = (v: string | undefined, d = false) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));
/**
 * Proxies à frente da aplicação (para o IP de quem pede, usado nos limites por IP). TRUST_PROXY: número de saltos
 * (por exemplo 1 com só o balanceador do Render), lista de endereços/redes, ou true/false. Sem valor fica `true`
 * (confia em todo o X-Forwarded-For, que o cliente pode forjar): defina o número certo de saltos em produção.
 */
export const parseTrustProxy = (v: string | undefined): boolean | number | string => {
  const s = String(v ?? '').trim();
  if (!s || /^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
};

export const config = {
  port: Number(env.PORT ?? 3000),
  trustProxy: parseTrustProxy(env.TRUST_PROXY),
  baseUrl: (env.BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
  brand: env.BRAND_NAME ?? 'quietinterview',
  // Endereço mostrado no cartão final dos vídeos.
  brandSite: env.BRAND_SITE ?? 'quietinterview.com',
  supportEmail: env.SUPPORT_EMAIL ?? 'support@example.com',
  // Entidade proprietária e gestora do portal (rodapé de todas as páginas).
  owner: {
    name: env.OWNER_NAME ?? 'Certif Int Association OÜ',
    country: env.OWNER_COUNTRY ?? 'EE',
    site: env.OWNER_SITE ?? 'https://www.certifinternational.com',
    email: env.OWNER_EMAIL ?? 'certifinternational@gmail.com',
  },
  // Quem comercializa o serviço (vende ao cliente final): valores por omissão das Definições «Empresa vendedora»,
  // mostrados nas páginas de compra, nos termos e nos orçamentos (o rodapé fica só com a entidade gestora, acima).
  seller: {
    name: env.SELLER_NAME ?? 'Telecert Consultoria Lda',
    vat: env.SELLER_VAT ?? 'PT514907274',
    address: env.SELLER_ADDRESS ?? 'Avenida 5 de Outubro, 38A, 8000-077 Faro',
    complaintsUrl: env.SELLER_COMPLAINTS_URL ?? 'https://www.livroreclamacoes.pt/Inicio/',
  },
  databaseUrl: env.DATABASE_URL ?? '',
  pgliteDir: env.PGLITE_DIR ?? './data/pglite',
  secret: env.APP_SECRET ?? (env.NODE_ENV === 'production' ? '' : 'dev-only-secret-' + randomBytes(8).toString('hex')),
  production: env.NODE_ENV === 'production',
  allowSignup: bool(env.ALLOW_SIGNUP, false),
  storage: { driver: env.STORAGE_DRIVER ?? 'local', dir: env.STORAGE_DIR ?? './storage',
    bucket: env.S3_BUCKET ?? '', region: env.S3_REGION ?? 'auto', endpoint: env.S3_ENDPOINT ?? '',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' },
  mail: { apiKey: env.MAILERSEND_API_KEY ?? '', from: env.MAIL_FROM ?? 'no-reply@example.com', fromName: env.MAIL_FROM_NAME ?? 'quietinterview' },
  openai: {
    apiKey: env.OPENAI_API_KEY ?? '',
    mock: bool(env.AI_MOCK, false),
    // Assistente da página de ajuda (fora de `models`, que entra na chave de deduplicação da geração dos episódios).
    assistantModel: env.OPENAI_MODEL_ASSISTANT ?? env.OPENAI_MODEL_TEXT ?? 'gpt-4.1',
    // Teto global de respostas do assistente redigidas pela IA por hora (todas as contas juntas); acima disto, só a pesquisa local.
    assistantAiPerHour: Number(env.ASSISTANT_AI_PER_HOUR ?? 120),
    models: {
      transcribe: env.OPENAI_MODEL_TRANSCRIBE ?? 'gpt-4o-transcribe',
      transcribeTimestamps: env.OPENAI_MODEL_TIMESTAMPS ?? 'whisper-1',
      text: env.OPENAI_MODEL_TEXT ?? 'gpt-4.1',
      speech: env.OPENAI_MODEL_SPEECH ?? 'gpt-4o-mini-tts',
      image: env.OPENAI_MODEL_IMAGE ?? 'gpt-image-1',
    },
    voices: { host: env.OPENAI_VOICE_HOST ?? 'coral', guest: env.OPENAI_VOICE_GUEST ?? 'onyx' },
  },
  limits: {
    maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 60),
    maxAnswerSeconds: Number(env.MAX_ANSWER_SECONDS ?? 300),
    maxQuestions: Number(env.MAX_QUESTIONS ?? 15),
    // Por entrevista, quando o plano não o indica (o plano manda; o administrador não tem limite).
    maxAnswerTotalSec: Number(env.MAX_ANSWER_TOTAL_SEC ?? 900),
    // Áudio do entrevistador: cada pergunta gravada e o objetivo.
    maxQuestionAudioSec: Number(env.MAX_QUESTION_AUDIO_SEC ?? 120),
    maxObjectiveAudioSec: Number(env.MAX_OBJECTIVE_AUDIO_SEC ?? 300),
    // Regenerações do guião e do episódio incluídas por entrevista; as seguintes custam 1 crédito.
    includedRegenerations: Number(env.INCLUDED_REGENERATIONS ?? 3),
    // Introdução animada do entrevistador (oferecida): gerações por entrevistador e por mês (o administrador não conta).
    introPerMonth: Number(env.INTRO_PER_MONTH ?? 3),
    inviteDays: Number(env.INVITE_DAYS ?? 14),
    resendCooldownSec: Number(env.RESEND_COOLDOWN_SEC ?? 120),
  },
  // Fila de trabalhos: duas vias (curta e vídeos; WORKER_LANES=1 volta à via única), batimento de quem corre um trabalho,
  // silêncio a partir do qual o trabalho se dá como interrompido, ciclo do vigilante e reinícios tolerados num trabalho
  // de orçamento (que retoma sem gastar tentativa).
  queue: {
    lanes: Number(env.WORKER_LANES ?? 2) === 1 ? 1 : 2,
    heartbeatMs: Number(env.JOB_HEARTBEAT_MS ?? 30_000),
    staleMs: Number(env.JOB_STALE_MS ?? 180_000),
    watchdogMs: Number(env.WORKER_WATCHDOG_MS ?? 60_000),
    maxInterruptions: Number(env.JOB_MAX_INTERRUPTIONS ?? 10),
  },
  // Preços ilustrativos e atualizáveis (USD). São ESTIMATIVAS, nunca custos confirmados.
  prices: {
    transcribePerMin: Number(env.PRICE_TRANSCRIBE_PER_MIN ?? 0.006),
    ttsPer1kChars: Number(env.PRICE_TTS_PER_1K_CHARS ?? 0.015),
    textPer1kTokens: Number(env.PRICE_TEXT_PER_1K_TOKENS ?? 0.004),
    imageEach: Number(env.PRICE_IMAGE_EACH ?? 0.04),
  },
  aiDisclosure:
    'This episode was produced from an asynchronous interview. It has been translated and narrated using AI-generated voices.',
};

export function assertProductionConfig() {
  if (config.production) {
    if (!config.secret || config.secret.length < 24) throw new Error('APP_SECRET em falta ou curto demais (min. 24 caracteres)');
    if (!config.databaseUrl) throw new Error('DATABASE_URL em falta');
  }
}
