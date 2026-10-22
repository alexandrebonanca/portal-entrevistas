import type { Db } from './db.ts';
import type { FaqAudience } from './assistant.ts';
import { sha256 } from './lib.ts';
import { LEGACY_SEED_HASHES } from './assistant-faq-legacy.ts';

/**
 * Semente da base de conhecimento do assistente, escrita a partir do que o portal faz hoje (cada resposta tem de ser
 * verdadeira no código atual). Os marcadores {…} são preenchidos com os valores em vigor (ver faqVars em
 * src/assistant.ts). As páginas do entrevistador estão em português: as respostas em inglês citam os botões em
 * português, com a tradução entre parênteses (as páginas da conta e dos créditos estão em inglês).
 *
 * Versões: cada entrada da base guarda a impressão (seed_hash) do texto que a semente lá escreveu. No arranque, as
 * entradas em falta são inseridas e as que o administrador não alterou (texto ainda igual a essa versão) passam ao
 * texto atual desta semente; as que ele alterou ficam como estão, e /admin/assistente mostra-lhe a versão nova para
 * decidir. Basta mudar aqui o texto de uma entrada: a versão é a própria impressão.
 */
type QA = [question: string, answer: string, keywords: string];
/** `sort`: posição explícita (as entradas acrescentadas depois da primeira semente, para não mudar a ordem das outras). */
export interface SeedEntry { key: string; audience: FaqAudience; sort?: number; pt: QA; en: QA }

export const FAQ_SEED: SeedEntry[] = [
  // ======================= entrevistadores (e gestores de entidade) =======================
  { key: 'criar-entrevista', audience: 'interviewer',
    pt: ['Como crio uma entrevista?',
      `No Painel, carregue em «Nova entrevista», escreva o título e carregue em «Criar rascunho». Abre a página de edição, onde define o objetivo, as perguntas, o nome e o email do entrevistado, as línguas, as vozes, a política de revisão e, se quiser, a sua fotografia. Pode guardar e voltar mais tarde: a entrevista fica em «Rascunho» até enviar o convite.`,
      'criar, nova entrevista, começar, rascunho, painel, título, primeira entrevista'],
    en: ['How do I create an interview?',
      `On the dashboard (Painel), press «Nova entrevista» (New interview), type a title and press «Criar rascunho» (Create draft). The edit page opens, where you set the goal, the questions, the guest's name and email, the languages, the voices, the review policy and, if you wish, your photo. You can save and come back later: the interview stays as a draft until you send the invitation.`,
      'create, new interview, start, draft, dashboard, title, first interview'] },

  { key: 'perguntas', audience: 'interviewer',
    pt: ['Como acrescento, gravo ou ordeno as perguntas?',
      `Na página de edição, em «Perguntas», escreva a pergunta e carregue em «Adicionar pergunta» (a página volta à caixa, pronta para a seguinte); para a gravar em áudio, carregue em «Adicionar e gravar áudio» (a página vai para o gravador dela). Em cada pergunta pode alterar o texto, gravá-la em áudio (o entrevistado ouve-a na sua voz; até {questionAudioMin} minutos por pergunta), mudar a ordem com ↑ e ↓, «Duplicar» ou «Eliminar». Uma pergunta gravada sem texto é transcrita automaticamente quando o serviço de IA está configurado. O seu plano permite até {maxQuestions} perguntas por entrevista, contando as adicionais. Depois de enviar o convite, as perguntas ficam bloqueadas.`,
      'perguntas, acrescentar, adicionar, ordem, ordenar, mover, duplicar, eliminar, gravar pergunta, áudio, quantas perguntas, número de perguntas, editar pergunta'],
    en: ['How do I add, record or reorder questions?',
      `On the edit page, under «Perguntas» (Questions), type the question and press «Adicionar pergunta» (Add question; the page returns to the box, ready for the next one); to record it as audio, press «Adicionar e gravar áudio» (Add and record audio; the page goes to its recorder). For each question you can change the text, record it as audio (the guest hears it in your voice; up to {questionAudioMin} minutes per question), change the order with ↑ and ↓, «Duplicar» (Duplicate) or «Eliminar» (Delete). A question recorded without text is transcribed automatically when the AI service is configured. Your plan allows up to {maxQuestions} questions per interview, additional ones included. After the invitation is sent, the questions are locked.`,
      'questions, add question, order, reorder, move, duplicate, delete, record question, audio, how many questions, number of questions, edit question'] },

  { key: 'objetivo', audience: 'interviewer',
    pt: ['Para que serve o objetivo da entrevista e quem o vê?',
      `O objetivo explica o tema e o propósito da entrevista. Pode escrevê-lo ou gravá-lo em áudio, até {objectiveAudioMin} minutos (o áudio é transcrito para poder copiar o texto, quando o serviço de IA está configurado). Só o texto é mostrado ao entrevistado, e só se marcar «Mostrar o objetivo ao entrevistado»; o áudio fica sempre interno, por isso copie a transcrição para o texto se quiser que ele o veja. É preciso ter objetivo, em texto ou em áudio, para enviar o convite.`,
      'objetivo, propósito, tema, mostrar objetivo, interno, finalidade, assunto'],
    en: ['What is the interview goal for, and who sees it?',
      `The goal explains the topic and purpose of the interview. You can type it or record it as audio, up to {objectiveAudioMin} minutes (the audio is transcribed so you can copy the text, when the AI service is configured). Only the text is shown to the guest, and only if you tick «Mostrar o objetivo ao entrevistado» (Show the goal to the guest); the audio always stays internal, so copy the transcript into the text if you want the guest to see it. A goal, as text or audio, is required to send the invitation.`,
      'goal, objective, purpose, topic, show goal, internal, subject'] },

  { key: 'assistente-composicao', audience: 'interviewer', sort: 35,
    pt: ['Como funciona o assistente de composição da entrevista?',
      `Na página de edição de um rascunho, o painel «Assistente de composição» fica aberto ao lado da entrevista nos ecrãs largos (nos estreitos, use o botão «✦ Assistente»). Dá dicas enquanto escreve (perguntas longas, duplas ou de «sim» ou «não», número de perguntas e tempo de resposta). Com uma subscrição ativa ou como gestor de entidade, também sugere perguntas novas, revê as existentes e propõe título e objetivo, com IA (OpenAI), até 30 pedidos por hora, 50 por dia e 300 por mês. São enviados o título, o objetivo, as funções e as perguntas guardadas do rascunho, tal como estão escritos, e o pedido opcional escrito no painel (os emails, os endereços de sites e os números de telefone nos formatos habituais são tapados); os campos de nome e de email e a mensagem pessoal não. Se a sua entidade tiver chave própria da OpenAI, é essa a usada. Nada muda na entrevista sem clicar em «Adicionar», «Substituir» ou «Guardar dados». Depois de enviar o convite, o painel deixa de aparecer.`,
      'assistente de composição, sugerir perguntas, sugestões de perguntas, sugestões, ideias de perguntas, melhorar perguntas, rever perguntas, ajuda a escrever, escrever perguntas, painel, dados enviados à OpenAI no assistente de composição'],
    en: ['How does the interview composition assistant work?',
      `On the edit page of a draft, the «Assistente de composição» (Composition assistant) panel stays open beside the interview on wide screens (on narrow ones, use the «✦ Assistente» button). It gives tips as you type (long questions, double questions or yes/no questions, number of questions and answer time). With an active subscription or as an entity manager, it also suggests new questions, reviews the existing ones and proposes a title and goal, using AI (OpenAI), up to 30 requests per hour, 50 per day and 300 per month. The draft's saved title, goal, roles and questions are sent as written, together with the optional request typed in the panel (emails, website addresses and phone numbers in the usual formats are masked); the name and email fields and the personal message are not. If your entity has its own OpenAI key, that key is used. Nothing changes in the interview until you press «Adicionar» (Add), «Substituir» (Replace) or «Guardar dados» (Save details). Once the invitation is sent, the panel no longer appears.`,
      'composition assistant, suggest questions, suggestions, question ideas, improve questions, review questions, help writing, write questions, panel, data sent to OpenAI by the composition assistant'] },

  { key: 'enviar-convite', audience: 'interviewer',
    pt: ['Como envio o convite ao entrevistado?',
      `Na página de edição, carregue em «Rever e convidar». O portal verifica se há título, objetivo, pelo menos uma pergunta (com texto ou áudio), o nome e um email válido do entrevistado e, se pôs a sua fotografia, a confirmação de que a pode usar. Também precisa de uma subscrição ativa com entrevistas disponíveis neste período (ver «Conta»); se já as usou, pode mudar de plano ou enviar o convite como entrevista extra, paga com créditos. Os gestores de entidade convidam sem subscrição. Com tudo certo, carregue em «Enviar convite»: o entrevistado recebe um email com um link pessoal, as perguntas ficam fixas e a entrevista fica com os limites do plano.`,
      'enviar convite, convidar, rever e convidar, link, enviar, convite, não consigo enviar'],
    en: ['How do I send the invitation to the guest?',
      `On the edit page, press «Rever e convidar» (Review and invite). The portal checks that there is a title, a goal, at least one question (with text or audio), the guest's name and a valid email and, if you added your photo, your confirmation that you may use it. You also need an active subscription with interviews left in this period (see «Conta», Account); if you have used them, you can change plan or send the invitation as an extra interview, paid with credits. Entity managers invite without a subscription. When everything is in order, press «Enviar convite» (Send invitation): the guest receives an email with a personal link, the questions are fixed and the interview takes the limits of your plan.`,
      'send invitation, invite, review and invite, link, send, invitation, cannot send'] },

  { key: 'entrevista-extra', audience: 'interviewer', sort: 43,
    pt: ['Já usei as entrevistas deste mês. Posso enviar mais convites?',
      `Sim. Em «Rever e convidar», quando atingiu o limite de entrevistas do período, pode mudar de plano em «Conta» ou enviar o convite como entrevista extra, por {extraInterviewCredits} créditos, com o botão «Enviar convite e pagar …». A entrevista extra é cobrada uma só vez, não conta para o limite do plano e tem os mesmos limites por entrevista. Se o saldo não chegar, a página mostra «Carregar o que falta». Os gestores de entidade não têm limite mensal de entrevistas.`,
      'entrevista extra, mais entrevistas, limite de entrevistas, acabaram, esgotei, sem entrevistas, convite extra, mais convites, este mês, por mês, limite mensal'],
    en: ['I have used up this month\'s interviews. Can I send more invitations?',
      `Yes. In «Rever e convidar» (Review and invite), once you have reached the interview limit for the period, you can change plan in «Conta» (Account) or send the invitation as an extra interview, for {extraInterviewCredits} credits, with the «Enviar convite e pagar …» (Send invitation and pay) button. The extra interview is charged only once, does not count towards your plan's limit and has the same per-interview limits. If your balance is not enough, the page shows «Carregar o que falta» (Top up what is missing). Entity managers have no monthly interview limit.`,
      'extra interview, more interviews, interview limit, run out, used up, no interviews left, extra invitation, more invitations, this month, per month, monthly limit'] },

  { key: 'limites-entrevista', audience: 'interviewer', sort: 45,
    pt: ['Que limites tem cada entrevista (tempo e perguntas)?',
      `Quando envia o convite, a entrevista fica com os limites do seu plano, que já não mudam: até {maxQuestions} perguntas (as adicionais incluídas) e até {maxAnswerTotalMin} minutos de respostas no total, somando todas as perguntas; cada resposta pode ter até {maxAnswerMin} minutos. O entrevistado vê o «Tempo restante» e a gravação para sozinha no limite. As perguntas que grava podem ter até {questionAudioMin} minutos cada e o objetivo gravado até {objectiveAudioMin} minutos. Cada entrevista inclui {includedRegens} regenerações do guião ou do episódio. Os gestores de entidade têm os mesmos limites por entrevista.`,
      'limites, limite de tempo, tempo total, minutos, duração da entrevista, quantas perguntas, máximo, tempo restante, comprimento'],
    en: ['What limits does each interview have (time and questions)?',
      `When you send the invitation, the interview takes the limits of your plan, which no longer change: up to {maxQuestions} questions (additional ones included) and up to {maxAnswerTotalMin} minutes of answers in total, across all questions; each answer can be up to {maxAnswerMin} minutes. The guest sees the time left and the recording stops by itself at the limit. The questions you record can be up to {questionAudioMin} minutes each and a recorded goal up to {objectiveAudioMin} minutes. Each interview includes {includedRegens} regenerations of the script or episode. Entity managers have the same per-interview limits.`,
      'limits, time limit, total time, minutes, interview length, how many questions, maximum, time left, length'] },

  { key: 'validade-link', audience: 'interviewer',
    pt: ['Quanto tempo é válido o link do convite? Posso definir um prazo?',
      `Por omissão, o link vale {inviteDays} dias a contar do envio. Se indicar um «Prazo» na página de edição, o link vale até ao fim desse dia (hora de Lisboa). O email ao entrevistado diz até quando pode responder. Se o link expirar, pode usar «Reenviar convite» na página da entrevista; o entrevistado também pode pedir um novo link na página do link expirado, com o mesmo email.`,
      'prazo, validade, expira, expirou, link, dias, data limite, quanto tempo, deadline'],
    en: ['How long is the invitation link valid? Can I set a deadline?',
      `By default the link is valid for {inviteDays} days from sending. If you set a «Prazo» (Deadline) on the edit page, the link is valid until the end of that day (Lisbon time). The email to the guest says until when they can answer. If the link expires, you can use «Reenviar convite» (Resend invitation) on the interview page; the guest can also ask for a new link on the expired-link page, with the same email.`,
      'deadline, validity, expire, expired, link, days, due date, how long'] },

  { key: 'nao-recebeu', audience: 'interviewer',
    pt: ['O entrevistado não recebeu o email. O que posso fazer?',
      `Na página da entrevista, o quadro «Emails» mostra o estado de cada email; «por enviar» quer dizer que ainda não saiu (por exemplo, se o envio de emails não estiver configurado no portal). Peça ao entrevistado para ver a pasta de spam. Pode usar «Reenviar convite (revoga o anterior)»: é criado um link novo e o anterior deixa de funcionar; entre dois reenvios é preciso esperar um pouco. Depois do envio, o email do entrevistado já não se altera na página de edição: se estiver errado, fale com o suporte.`,
      'não recebeu, não recebi, email, spam, reenviar, convite, link novo, email errado, não chegou'],
    en: ['The guest did not receive the email. What can I do?',
      `On the interview page, the «Emails» box shows the state of each email; «por enviar» (pending) means it has not gone out yet (for example, if email sending is not configured on the portal). Ask the guest to check their spam folder. You can use «Reenviar convite (revoga o anterior)» (Resend invitation, revokes the previous one): a new link is created and the old one stops working; you have to wait a little between two resends. After sending, the guest's email can no longer be changed on the edit page: if it is wrong, contact support.`,
      'not received, did not get, email, spam, resend, invitation, new link, wrong email, never arrived'] },

  { key: 'pergunta-adicional', audience: 'interviewer',
    pt: ['Posso acrescentar uma pergunta depois de enviar o convite?',
      `Sim. Depois do envio as perguntas ficam bloqueadas, mas na página de edição aparece «Pedido adicional»: escreva a nova pergunta e carregue em «Acrescentar e reenviar convite». A pergunta fica marcada como adicional e o entrevistado recebe um email com um link novo (o anterior deixa de valer). Se ele já tinha submetido, a entrevista passa a «Reaberta» para responder à pergunta nova. Não é possível acrescentar quando a entrevista já tem o número máximo de perguntas do plano, quando restam menos de {followupMinSec} segundos de tempo de resposta ou quando está cancelada ou expirada.`,
      'pergunta adicional, pedido adicional, acrescentar pergunta, depois do convite, bloqueadas, nova pergunta, mais uma pergunta'],
    en: ['Can I add a question after sending the invitation?',
      `Yes. After sending, the questions are locked, but the edit page shows «Pedido adicional» (Additional request): type the new question and press «Acrescentar e reenviar convite» (Add and resend invitation). The question is marked as additional and the guest receives an email with a new link (the old one stops working). If they had already submitted, the interview becomes «Reaberta» (Reopened) so they can answer the new question. It is not possible when the interview already has the plan's maximum number of questions, when less than {followupMinSec} seconds of answer time are left, or when it is cancelled or expired.`,
      'additional question, follow-up, add question, after invitation, locked, new question, one more question'] },

  { key: 'cancelar', audience: 'interviewer',
    pt: ['Como cancelo uma entrevista?',
      `Na página da entrevista, depois de enviar o convite e antes de o entrevistado submeter, carregue em «Cancelar». Os links enviados deixam de funcionar e a entrevista fica «Cancelada». Por agora não há forma de apagar entrevistas no portal; para pedir a eliminação de dados, fale com o suporte.`,
      'cancelar, anular, parar, desistir, apagar entrevista, eliminar entrevista'],
    en: ['How do I cancel an interview?',
      `On the interview page, after sending the invitation and before the guest submits, press «Cancelar» (Cancel). The links sent stop working and the interview becomes «Cancelada» (Cancelled). For now interviews cannot be deleted on the portal; to ask for data to be erased, contact support.`,
      'cancel, stop, abort, delete interview, remove interview'] },

  { key: 'como-responde', audience: 'interviewer',
    pt: ['Como é que o entrevistado responde?',
      `O entrevistado abre o link pessoal no telemóvel ou no computador, sem instalar nada nem criar conta. Primeiro escolhe as autorizações; depois ouve cada pergunta (gravada por si ou lida por uma voz gerada por IA, identificada como tal), grava a resposta, pode ouvi-la e repeti-la, ou carregar um áudio já gravado. Cada resposta pode ter até {maxAnswerMin} minutos e todas juntas até {maxAnswerTotalMin} minutos (o limite do plano): a página mostra-lhe o tempo restante. Pode recusar uma pergunta, guardar e continuar mais tarde e, no fim, juntar até três fotografias, se quiser, e submeter.`,
      'como responde, entrevistado, experiência do convidado, telemóvel, gravar, responder, o que vê o convidado'],
    en: ['How does the guest answer?',
      `The guest opens the personal link on a phone or computer, with nothing to install and no account. First they choose their permissions; then they listen to each question (recorded by you, or read by an AI-generated voice that is labelled as such), record the answer, can play it back and redo it, or upload an existing recording. Each answer can be up to {maxAnswerMin} minutes and all of them together up to {maxAnswerTotalMin} minutes (the plan's limit): the page shows them the time left. They can decline a question, save and continue later and, at the end, add up to three photos if they wish, and submit.`,
      'how guest answers, guest experience, phone, record, answer, what the guest sees'] },

  { key: 'saber-respondeu', audience: 'interviewer',
    pt: ['Como sei que o entrevistado respondeu ou recusou?',
      `Quando o entrevistado submete a entrevista, recebe um email com o resumo (respostas, fotografias e perguntas recusadas) e a ligação para a produção do podcast. Se ele escolher «Não pretendo participar», também recebe um email. No Painel, o estado da recolha passa a «Iniciada» quando ele abre o link, e a coluna «Respostas» mostra quantas perguntas já respondeu ou recusou.`,
      'notificação, aviso, respondeu, submeteu, recusou, saber, email ao entrevistador, progresso'],
    en: ['How do I know the guest has answered or declined?',
      `When the guest submits the interview, you receive an email with a summary (answers, photos and declined questions) and the link to the podcast production. If they choose «Não pretendo participar» (I do not wish to take part), you also receive an email. On the dashboard, the collection status becomes «Iniciada» (Started) when they open the link, and the «Respostas» (Answers) column shows how many questions they have answered or declined.`,
      'notification, alert, answered, submitted, declined, know, email to interviewer, progress'] },

  { key: 'ver-respostas', audience: 'interviewer',
    pt: ['Onde ouço as respostas e vejo as fotografias e autorizações?',
      `Na página da entrevista (a partir do Painel): a tabela «Respostas» mostra cada pergunta com o estado (respondida, recusada ou pendente) e o áudio; a seguir estão as fotografias do entrevistado, as autorizações que deu (com a versão do texto e a data) e os emails enviados. Os ficheiros originais só são mostrados a si e à administração do portal.`,
      'ouvir respostas, ver respostas, áudio, fotografias, autorizações, consentimentos, onde estão'],
    en: ['Where do I listen to the answers and see the photos and permissions?',
      `On the interview page (from the dashboard): the «Respostas» (Answers) table shows each question with its state (answered, declined or pending) and the audio; below are the guest's photos, the permissions they gave (with the text version and the date) and the emails sent. The original files are only shown to you and to the portal administration.`,
      'listen answers, see answers, audio, photos, permissions, consents, where'] },

  { key: 'estados', audience: 'interviewer',
    pt: ['O que querem dizer os estados da entrevista?',
      `Recolha: «Rascunho» (ainda não enviada), «Convidada» (convite enviado), «Iniciada» (o entrevistado abriu o link), «Submetida» (respostas entregues), «Reaberta» (perguntas adicionais depois de submeter) e «Cancelada». Produção: «Produção não pedida», «Em fila», «Transcrição», «Revisão editorial», «Geração», «Pronta», «Controlo de qualidade» (há alertas a corrigir), «Falhou» e «Desatualizada» (as respostas mudaram depois do guião). Publicação: «Privada», «Aguarda aprovação», «Publicada» e «Retirada».`,
      'estado, estados, rascunho, convidada, iniciada, submetida, reaberta, pronta, falhou, desatualizada, significado'],
    en: ['What do the interview statuses mean?',
      `Collection: «Rascunho» (draft, not sent), «Convidada» (invited), «Iniciada» (the guest opened the link), «Submetida» (answers submitted), «Reaberta» (reopened: additional questions after submitting) and «Cancelada» (cancelled). Production: «Produção não pedida» (not requested), «Em fila» (queued), «Transcrição» (transcribing), «Revisão editorial» (editorial review), «Geração» (generating), «Pronta» (ready), «Controlo de qualidade» (quality alerts to fix), «Falhou» (failed) and «Desatualizada» (outdated: the answers changed after the script). Publication: «Privada» (private), «Aguarda aprovação» (awaiting approval), «Publicada» (published) and «Retirada» (withdrawn).`,
      'status, statuses, draft, invited, started, submitted, reopened, ready, failed, outdated, meaning'] },

  { key: 'autorizacoes', audience: 'interviewer',
    pt: ['Que autorizações dá o entrevistado e o que acontece se recusar?',
      `As autorizações são escolhas separadas, sem nada pré-selecionado, guardadas com o texto exato mostrado: participação e gravação (necessária, com a confirmação de ter 18 anos ou mais), tratamento por IA (transcrição, tradução e vozes sintéticas), publicação e, para as fotografias, captação, uso na capa, publicação, animação por IA e vídeo IA. Sem a autorização de tratamento por IA não é possível processar o podcast, e não há forma de contornar esta decisão. Sem a de publicação, o episódio não pode ser publicado.`,
      'autorizações, consentimento, recusou, tratamento por IA, RGPD, permissões, não autorizou'],
    en: ['What permissions does the guest give, and what if they refuse?',
      `Permissions are separate choices, nothing pre-ticked, stored with the exact text shown: taking part and recording (required, with confirmation of being 18 or older), AI processing (transcription, translation and synthetic voices), publication and, for photos, capture, cover use, publication, AI animation and AI video. Without the AI processing permission the podcast cannot be processed, and there is no way around that decision. Without the publication permission, the episode cannot be published.`,
      'permissions, consent, refused, AI processing, GDPR, did not allow'] },

  { key: 'linguas', audience: 'interviewer',
    pt: ['Em que línguas funciona? E as legendas?',
      `As páginas do entrevistado estão em português (PT) ou em inglês, conforme escolher em «Idioma da interação do entrevistado». Ele responde na sua língua; em «Idioma esperado das respostas» pode indicar português, inglês, espanhol, francês ou alemão, ou deixar a deteção automática. O episódio é sempre produzido em inglês, com vozes sintéticas, e pode ter legendas em inglês, português, espanhol, francês e alemão (escolhe as línguas ao gerar o episódio).`,
      'línguas, idioma, legendas, inglês, português, espanhol, francês, alemão, tradução, traduzir'],
    en: ['Which languages are supported? What about subtitles?',
      `The guest's pages are in Portuguese (PT) or English, as you choose in «Idioma da interação do entrevistado» (Guest interaction language). The guest answers in their own language; in «Idioma esperado das respostas» (Expected answer language) you can set Portuguese, English, Spanish, French or German, or leave automatic detection. The episode is always produced in English, with synthetic voices, and can have subtitles in English, Portuguese, Spanish, French and German (you choose them when generating the episode).`,
      'languages, language, subtitles, English, Portuguese, Spanish, French, German, translation, translate'] },

  { key: 'vozes', audience: 'interviewer',
    pt: ['Que vozes são usadas? A voz do entrevistado é clonada?',
      `Não há clonagem de voz. O episódio é narrado com vozes sintéticas de catálogo, geradas por IA: na página de edição escolha uma voz feminina ou masculina para o entrevistador e outra para o entrevistado (são sempre diferentes entre si). O episódio começa com um aviso audível de que foi traduzido e narrado com vozes geradas por IA. Nas falas animadas pelo Google Veo, a voz é a do próprio modelo, também gerada por IA. Para o entrevistado ouvir as perguntas na sua própria voz, grave-as em áudio.`,
      'voz, vozes, clonagem, clonar, voz sintética, narração, feminina, masculina, aviso'],
    en: ['Which voices are used? Is the guest\'s voice cloned?',
      `No voice is cloned. The episode is narrated with catalogue synthetic voices generated by AI: on the edit page, choose a female or male voice for the interviewer and another for the guest (they are always different from each other). The episode opens with an audible notice that it was translated and narrated with AI-generated voices. In lines animated by Google Veo, the voice is the model's own, also AI-generated. For the guest to hear the questions in your own voice, record them as audio.`,
      'voice, voices, cloning, clone, synthetic voice, narration, female, male, disclosure'] },

  { key: 'fotografia-entrevistador', audience: 'interviewer',
    pt: ['Como uso a minha fotografia?',
      `Na página de edição, em «A minha fotografia», carregue uma imagem JPEG ou PNG e marque «Tenho direito a usar a minha fotografia neste projeto» (sem esta confirmação o convite não é enviado). A sua fotografia entra no vídeo do podcast; a capa usa as fotografias do entrevistado que ele autorizou para a capa. Animar a sua fotografia com o Google Veo (por orçamento, ou na introdução animada oferecida) exige também a sua autorização para o Google Veo, na página de edição.`,
      'minha fotografia, minha foto, foto do entrevistador, pôr a minha foto, direitos da fotografia, imagem'],
    en: ['How do I use my own photo?',
      `On the edit page, under «A minha fotografia» (My photo), upload a JPEG or PNG image and tick «Tenho direito a usar a minha fotografia neste projeto» (I have the right to use my photo in this project); without this confirmation the invitation is not sent. Your photo appears in the podcast video; the cover uses the guest's photos that they allowed for the cover. Animating your photo with Google Veo (on a quote, or in the free animated introduction) also needs your Google Veo permission, on the edit page.`,
      'my photo, my picture, interviewer photo, add my photo, photo rights, image'] },

  { key: 'processar', audience: 'interviewer',
    pt: ['Como faço o podcast depois de o entrevistado submeter?',
      `Na página da entrevista, abra «Produção do podcast». Reveja os áudios originais e as autorizações e veja a estimativa do uso de IA; depois carregue em «Processar podcast». O portal transcreve as respostas e prepara um guião em inglês para rever. O processamento está incluído no plano, nada pago é feito antes de carregar no botão e exige a autorização de tratamento por IA do entrevistado. Pode fechar a página: o trabalho continua no servidor e a barra de progresso mostra o andamento.`,
      'processar, produção, podcast, fazer o episódio, começar produção, processar podcast'],
    en: ['How do I make the podcast after the guest submits?',
      `On the interview page, open «Produção do podcast» (Podcast production). Review the original audio and the permissions and see the AI usage estimate; then press «Processar podcast» (Process podcast). The portal transcribes the answers and prepares an English script for you to review. Processing is included in your plan, nothing paid runs before you press the button, and it requires the guest's AI processing permission. You can close the page: the work continues on the server and the progress bar shows how it is going.`,
      'process, production, podcast, make the episode, start production, process podcast'] },

  { key: 'guiao', audience: 'interviewer',
    pt: ['Como reviso e aprovo o guião?',
      `Na «Produção do podcast» aparecem as transcrições originais (pode corrigi-las; cada correção é uma nova revisão) e o guião em inglês, por segmentos. Pode editar o texto e guardá-lo como nova revisão, regenerar o guião a partir das transcrições (conta como uma das regenerações da entrevista) e pedir a «Verificação de fidelidade (assistente)», que só assinala possíveis problemas e nunca aprova. Para aprovar, confirme «Revi o guião contra as transcrições» e carregue em «Aprovar guião para síntese». Com bloqueios editoriais não é possível aprovar.`,
      'guião, rever guião, editar guião, aprovar guião, transcrição, fidelidade, corrigir, revisão'],
    en: ['How do I review and approve the script?',
      `«Produção do podcast» shows the original transcripts (you can correct them; each correction is a new revision) and the English script, by segments. You can edit the text and save it as a new revision, regenerate the script from the transcripts (this counts as one of the interview's regenerations) and ask for the «Verificação de fidelidade (assistente)» (faithfulness check), which only flags possible issues and never approves. To approve, tick «Revi o guião contra as transcrições» (I reviewed the script against the transcripts) and press «Aprovar guião para síntese» (Approve script for synthesis). With editorial blocks it cannot be approved.`,
      'script, review script, edit script, approve script, transcript, faithfulness, correct, revision'] },

  { key: 'gerar-episodio', audience: 'interviewer',
    pt: ['Como gero o episódio, as legendas e a capa?',
      `Depois de aprovar o guião, em «Gerar áudio, legendas e capa», escolha as línguas das legendas e, se o entrevistado autorizou o uso na capa, até duas fotografias dele; sem fotografias autorizadas é usada uma capa tipográfica. Carregue em «Gerar episódio». O episódio fica com leitor, capítulos, transcrição e legendas (VTT e SRT para descarregar) e passa por um controlo de qualidade do som antes de poder ser publicado. Gerar o episódio de novo, quando já existe um, conta como regeneração.`,
      'gerar episódio, áudio, legendas, capa, fotografias na capa, gerar, vtt, srt'],
    en: ['How do I generate the episode, subtitles and cover?',
      `After approving the script, in «Gerar áudio, legendas e capa» (Generate audio, subtitles and cover), choose the subtitle languages and, if the guest allowed cover use, up to two of their photos; without authorised photos a typographic cover is used. Press «Gerar episódio» (Generate episode). The episode gets a player, chapters, a transcript and subtitles (VTT and SRT to download) and goes through a sound quality check before it can be published. Generating the episode again, when one already exists, counts as a regeneration.`,
      'generate episode, audio, subtitles, cover, cover photos, generate, vtt, srt'] },

  { key: 'regeneracoes', audience: 'interviewer', sort: 195,
    pt: ['Quantas vezes posso regenerar o guião ou o episódio?',
      `Cada entrevista inclui {includedRegens} regenerações, somando as do guião e as do episódio: «Regenerar guião a partir das transcrições», gerar o episódio de novo e processar outra vez depois de «Recomeçar produção». O primeiro processamento e a primeira geração do episódio não contam, nem as que falham. A «Produção do podcast» mostra quantas já usou. A partir daí, cada regeneração custa {extraRegenCredits} crédito: o botão mostra o valor, a cobrança é única e o crédito volta ao saldo se o trabalho falhar. Gerar o vídeo não conta como regeneração.`,
      'regenerar, regenerações, quantas vezes, refazer guião, gerar de novo, outra vez, incluídas, limite de regenerações, recomeçar'],
    en: ['How many times can I regenerate the script or the episode?',
      `Each interview includes {includedRegens} regenerations, counting both script and episode: «Regenerar guião a partir das transcrições» (Regenerate script from transcripts), generating the episode again and processing again after «Recomeçar produção» (Restart production). The first processing and the first episode generation do not count, nor do the ones that fail. «Produção do podcast» shows how many you have used. After that, each regeneration costs {extraRegenCredits} credit: the button shows the amount, it is charged once and the credit goes back to your balance if the job fails. Generating the video does not count as a regeneration.`,
      'regenerate, regenerations, how many times, redo script, generate again, again, included, regeneration limit, restart'] },

  { key: 'politica-revisao', audience: 'interviewer',
    pt: ['O que é a política de revisão e publicação?',
      `Define quem aprova antes de publicar. «O entrevistado vê e aprova a versão final antes de publicar» é a opção por omissão e a recomendada. «Só o entrevistador aprova» dispensa a aprovação do entrevistado, exceto num vídeo em que ele apareça animado por IA, que ele vê e aprova sempre; com esta política, o entrevistado não entra na animação do Google Veo. A política é comunicada no convite; depois de enviado o convite, já não pode passar a «Só o entrevistador aprova».`,
      'política de revisão, aprovação, quem aprova, entrevistado aprova, só o entrevistador'],
    en: ['What is the review and publication policy?',
      `It sets who approves before publishing. «O entrevistado vê e aprova a versão final antes de publicar» (the guest sees and approves the final version) is the default and recommended option. «Só o entrevistador aprova» (only the interviewer approves) skips the guest's approval, except for a video in which they appear animated by AI, which they always see and approve; with this policy, the guest is not animated by Google Veo. The policy is stated in the invitation; once the invitation is sent, it can no longer change to «only the interviewer approves».`,
      'review policy, approval, who approves, guest approves, only interviewer'] },

  { key: 'validacao-entrevistado', audience: 'interviewer',
    pt: ['Como peço ao entrevistado para validar o episódio?',
      `Na secção «Episódio» da produção, carregue em «Enviar pré-visualização»: o entrevistado recebe um email com um link pessoal para ver o episódio (e o vídeo, se houver) e escolher «Aprovo esta versão» ou «Quero pedir alterações», com uma nota. Isto só existe com a política «O entrevistado vê e aprova a versão final antes de publicar», ou quando ele aparece animado por IA no vídeo; com «Só o entrevistador aprova», a aprovação é só sua. A sua própria aprovação é o botão «Aprovar esta versão». O silêncio nunca conta como aprovação, e uma aprovação só vale para a versão vista: um vídeo novo ou respostas alteradas exigem nova aprovação. Num episódio já publicado, o entrevistado só vê e ouve, sem aprovar.`,
      'validar, validação, pré-visualização, aprovar episódio, aprovação do entrevistado, pedir alterações, enviar pré-visualização'],
    en: ['How do I ask the guest to validate the episode?',
      `In the «Episódio» (Episode) section of the production page, press «Enviar pré-visualização» (Send preview): the guest receives an email with a personal link to watch the episode (and the video, if any) and choose «I approve this version» or «I want to request changes», with a note. This only exists with the «O entrevistado vê e aprova a versão final antes de publicar» policy (the guest sees and approves the final version), or when the guest appears animated by AI in the video; with «Só o entrevistador aprova» (only the interviewer approves), the approval is yours alone. Your own approval is the «Aprovar esta versão» (Approve this version) button. Silence never counts as approval, and an approval only covers the version seen: a new video or changed answers require a new approval. On an episode already published, the guest only watches and listens, without approving.`,
      'validate, validation, preview, approve episode, guest approval, request changes, send preview'] },

  { key: 'publicar', audience: 'interviewer',
    pt: ['Como publico o episódio e que visibilidades existem?',
      `Em «Publicar», escolha a visibilidade do episódio: «Privado» (só pessoas autorizadas no portal), «Não listado» (quem tem o link; não é o mesmo que privado) ou «Público» (indexável pelos motores de pesquisa). Para publicar é preciso a sua aprovação válida, a do entrevistado quando é exigida, a autorização de publicação do entrevistado, a versão atual (não desatualizada), nenhum alerta de qualidade e nenhum vídeo a ser gerado. Se não for possível, o motivo aparece junto do botão. Nada é publicado automaticamente.`,
      'publicar, publicação, visibilidade, privado, não listado, público, link do episódio, partilhar episódio, quem pode ver, quem pode ouvir'],
    en: ['How do I publish the episode, and what visibility options are there?',
      `Under «Publicar» (Publish), choose the episode's visibility: «Privado» (private: only authorised people on the portal), «Não listado» (unlisted: anyone with the link; not the same as private) or «Público» (public: indexable by search engines). Publishing requires your valid approval, the guest's when it is required, the guest's publication permission, the current version (not outdated), no quality alerts and no video being generated. If it is not possible, the reason appears next to the button. Nothing is published automatically.`,
      'publish, publication, visibility, private, unlisted, public, episode link, share episode, who can see, who can listen'] },

  { key: 'galeria', audience: 'interviewer',
    pt: ['O que é a galeria pública «Podcasts gerados»?',
      `É a página pública do portal com episódios publicados como «Público», organizados por temas. Um episódio só entra se marcar «Permito que este episódio fique na galeria pública do portal» ao publicar (ou depois, na página de produção); se quiser, indique um tema (sem tema, fica no grupo «Other»). Pode tirá-lo da galeria a qualquer momento; retirar o episódio também o tira da galeria.`,
      'galeria, podcasts gerados, tema, temas, lista, montra'],
    en: ['What is the public gallery?',
      `It is the portal's public page with episodes published as «Público» (public), organised by theme. An episode only appears there if you tick the gallery permission when publishing (or later, on the production page); you can also give it a theme (without one, it is listed under «Other»). You can take it out of the gallery at any time; withdrawing the episode also removes it from the gallery.`,
      'gallery, generated podcasts, theme, themes, list, showcase'] },

  { key: 'retirar', audience: 'interviewer',
    pt: ['Como retiro um episódio publicado ou recomeço a produção?',
      `Na produção, «Retirar episódio» deixa-o indisponível de imediato e tira-o da galeria; cópias já descarregadas ou partilhadas fora do portal podem não ser recuperáveis. Um episódio retirado não volta a ser publicado. «Recomeçar produção» arquiva o guião e o episódio atuais (não os apaga) e volta ao passo «Processar podcast»; as gravações e as transcrições originais mantêm-se e, se o episódio estiver publicado, é retirado. Processar de novo conta como uma regeneração.`,
      'retirar, despublicar, remover episódio, recomeçar, reiniciar, voltar atrás, arquivar'],
    en: ['How do I withdraw a published episode or restart the production?',
      `On the production page, «Retirar episódio» (Withdraw episode) makes it unavailable at once and removes it from the gallery; copies already downloaded or shared outside the portal may not be recoverable. A withdrawn episode cannot be published again. «Recomeçar produção» (Restart production) archives the current script and episode (it does not delete them) and goes back to «Processar podcast»; the original recordings and transcripts are kept and, if the episode was published, it is withdrawn. Processing again counts as a regeneration.`,
      'withdraw, unpublish, remove episode, restart, reset, start over, archive'] },

  { key: 'desatualizado', audience: 'interviewer',
    pt: ['Porque é que o episódio aparece como desatualizado?',
      `Quando uma resposta ou uma transcrição muda depois de haver guião ou episódio, as aprovações deixam de valer e o que foi gerado fica «desatualizado», sem ser apagado. Regenere o guião a partir das transcrições, aprove-o e gere o episódio de novo (contam como regenerações); depois peça outra vez as aprovações.`,
      'desatualizado, desatualizada, aprovações inválidas, regenerar, mudou, alterado'],
    en: ['Why does the episode show as outdated?',
      `When an answer or a transcript changes after a script or episode exists, the approvals stop being valid and what was generated becomes «desatualizado» (outdated), without being deleted. Regenerate the script from the transcripts, approve it and generate the episode again (these count as regenerations); then ask for the approvals again.`,
      'outdated, stale, invalid approvals, regenerate, changed'] },

  { key: 'video-fotografias', audience: 'interviewer',
    pt: ['Como faço o vídeo do podcast com fotografias?',
      `Na secção «Vídeo do podcast», escolha «Fotografias fixas com a voz do episódio», a língua das legendas no vídeo (ou sem legendas) e carregue em «Gerar vídeo». O vídeo mostra a capa no aviso inicial e no agradecimento final, os dois em estúdio na apresentação e, a partir da primeira pergunta, quem fala em grande plano, com as legendas gravadas na imagem numa só língua, e leva grafismo animado (cartões, nomes e capítulos). Só entram fotografias autorizadas. Está incluído em todos os planos, sem IA. O vídeo só se gera antes de publicar o episódio; depois pode usar «Descarregar vídeo (MP4)». Um vídeo novo exige nova aprovação de quem já aprovou.`,
      'vídeo, vídeo com fotografias, mp4, descarregar vídeo, gerar vídeo, legendas no vídeo'],
    en: ['How do I make the podcast video with photos?',
      `In the «Vídeo do podcast» (Podcast video) section, choose «Fotografias fixas com a voz do episódio» (still photos with the episode voice), the subtitle language burned into the video (or none) and press «Gerar vídeo» (Generate video). The video shows the cover during the opening notice and the closing thanks, both people in a studio layout during the introduction and, from the first question on, whoever is speaking in close-up, with subtitles burned into the picture in one language, plus animated graphics (cards, names and chapters). Only authorised photos are used. It is included in every plan, with no AI. The video can only be generated before the episode is published; then use «Descarregar vídeo (MP4)» (Download video). A new video needs a new approval from whoever already approved.`,
      'video, video with photos, mp4, download video, generate video, subtitles in video'] },

  { key: 'grafismo-video', audience: 'interviewer', sort: 265,
    pt: ['Que grafismo leva o vídeo (cartão de título, nomes e capítulos)?',
      `Todos os vídeos, em todos os planos e sem IA, levam grafismo animado sobre um fundo em movimento feito da capa: um cartão de título a seguir ao aviso inicial (o título do episódio, «with» e o nome do entrevistado, e a marca), um rodapé com o nome e a função de cada pessoa na primeira vez que fala no seu plano (sempre acima das legendas), um título de capítulo no início de cada pergunta («QUESTION», o número e a pergunta, cortada se for longa) e um cartão final («Thank you for watching», a marca e {brandSite}). Os dois cartões acrescentam cerca de 8 segundos, em silêncio. A função de cada um escreve-se em inglês na página de edição, em «Função do entrevistador no vídeo» e «Função do entrevistado no vídeo»; se ficar vazia, aparece «Host» ou «Guest».`,
      'grafismo, cartão de título, cartão final, nomes no vídeo, rodapé, função, cargo, capítulos, títulos, fundo animado, fundo em movimento, texto no vídeo, host, guest'],
    en: ['What graphics does the video have (title card, names and chapters)?',
      `Every video, in every plan and with no AI, has animated graphics over a moving background made from the cover: a title card after the opening notice (the episode title, «with» and the guest's name, and the brand), a lower third with each person's name and role the first time they speak in their own shot (always above the subtitles), a chapter title at the start of each question («QUESTION», the number and the question, shortened if long) and an end card («Thank you for watching», the brand and {brandSite}). The two cards add about 8 seconds of silence. Each person's role is written in English on the edit page, in «Função do entrevistador no vídeo» (Interviewer's role in the video) and «Função do entrevistado no vídeo» (Guest's role in the video); if left empty, «Host» or «Guest» is shown.`,
      'graphics, title card, end card, names in video, lower third, role, job title, chapters, titles, animated background, moving background, text in video, host, guest'] },

  { key: 'video-ia', audience: 'interviewer',
    pt: ['Posso ter um vídeo com animação por IA (Google Veo)?',
      `Sim, por orçamento: os planos não incluem animação. Na produção, na secção «Animação por IA», escolha as falas a animar e carregue em «Calcular orçamento (grátis, não cativa nada)». O orçamento mostra o preço de cada fala em créditos (pela duração no áudio do episódio, com um mínimo de 4 segundos por fala, à tarifa por minuto indicada), o total, o saldo antes e depois e a validade ({quoteValidDays} dias). Só o titular da entrevista o aceita e paga-se com créditos; as falas que não saírem animadas e verificadas palavra a palavra não se pagam. Para animar as falas do entrevistador, ele tem de autorizar o Google Veo na página de edição; o entrevistado só aparece animado se der a autorização própria e com a política «O entrevistado vê e aprova», e vê e aprova o vídeo antes de ser publicado. O vídeo leva sempre o aviso visível «AI-generated video · AI voice». Os retratos animados (Replicate) estão reservados ao administrador.`,
      'animação, IA, vídeo IA, Veo, Google Veo, retrato animado, avatar, lipsync, animar fotografia, vídeo animado, falas animadas, preço da animação, quanto custa animar'],
    en: ['Can I have a video with AI animation (Google Veo)?',
      `Yes, on a quote: plans do not include animation. On the production page, in the «Animação por IA» (AI animation) section, choose the lines to animate and press «Calcular orçamento (grátis, não cativa nada)» (Calculate quote: free, holds nothing). The quote shows the price of each line in credits (by its length in the episode audio, at least 4 seconds per line, at the per-minute rate shown), the total, your balance before and after and the validity ({quoteValidDays} days). Only the interview's owner accepts it, and it is paid with credits; lines that do not come out animated and verified word by word are not paid. To animate the interviewer's lines, the interviewer must allow Google Veo on the edit page; the guest only appears animated if they give their own permission and with the «O entrevistado vê e aprova» (the guest approves) policy, and they see and approve the video before it is published. The video always carries the visible notice «AI-generated video · AI voice». Animated portraits (Replicate) are reserved for the administrator.`,
      'animation, AI, AI video, Veo, Google Veo, animated portrait, avatar, lipsync, animate photo, animated video, animated lines, animation price, how much to animate'] },

  { key: 'orcamento-aceitar', audience: 'interviewer', sort: 272,
    pt: ['Como aceito o orçamento da animação e o que me é cobrado?',
      `Abra o orçamento a partir da secção «Animação por IA», confira a tabela por fala, o total, a tarifa, o saldo antes e depois, o prazo e as garantias, assinale as duas caixas e carregue em «Aceitar e pagar …». Se o saldo não chegar, use «Carregar o que falta». Na aceitação, o valor fica cativo na sua carteira, recebe o orçamento por email e a produção entra na fila (a página mostra a posição e a espera estimada). O orçamento aceite é o máximo: nunca se cobra mais. No fim cobram-se só as falas animadas e verificadas; o resto volta ao saldo automaticamente e o relatório por fala diz o motivo. Uma produção que falhe, seja anulada ou não arranque nas {startDeadlineHours} horas seguintes ao momento em que pode começar custa 0 créditos. As falas já pagas reaproveitam-se a 0 créditos noutras versões do vídeo. Pode cancelar antes de começar (o cativo volta ao saldo). O orçamento deixa de valer se mudar o guião, as fotografias, as vozes ou as autorizações.`,
      'orçamento, aceitar orçamento, pagar animação, cativo, cativar, cobrado, cobrança, garantias, relatório, falas animadas, fila, prazo, cancelar orçamento'],
    en: ['How do I accept the animation quote, and what am I charged?',
      `Open the quote from the «Animação por IA» (AI animation) section, check the per-line table, the total, the rate, your balance before and after, the deadline and the guarantees, tick both boxes and press «Aceitar e pagar …» (Accept and pay). If your balance is not enough, use «Carregar o que falta» (Top up what is missing). On acceptance, the amount is held in your wallet, you receive the quote by email and the production joins the queue (the page shows its position and the estimated wait). The accepted quote is the maximum: you are never charged more. At the end only the lines that were animated and verified are charged; the rest goes back to your balance automatically and the per-line report gives the reason. A production that fails, is cancelled or does not start within {startDeadlineHours} hours of when it could start costs 0 credits. Lines already paid are reused at 0 credits in other versions of the video. You can cancel before it starts (the held amount goes back to your balance). The quote stops being valid if you change the script, the photos, the voices or the permissions.`,
      'quote, accept quote, pay for animation, held, hold, charged, charge, guarantees, report, animated lines, queue, deadline, cancel quote'] },

  { key: 'introducao-animada', audience: 'interviewer', sort: 275,
    pt: ['O que é a introdução animada do entrevistador?',
      `É uma oferta: nos vídeos com animação do Google Veo, logo a seguir ao aviso inicial de IA e antes do cartão de título, aparece a sua fotografia animada a dizer uma frase de boas-vindas em inglês, com o aviso visível «AI-generated video · AI voice». Na página de edição, em «Introdução animada (Google Veo), oferecida», escolha uma das três frases (genéricas e sem nomes: o seu nome aparece em texto, no rodapé) e carregue em «Gerar introdução». Não usa créditos nem entra no orçamento. É gerada uma vez e reaproveitada em todas as suas entrevistas enquanto a fotografia, a frase, a voz, o nível do Veo e o formato não mudarem. Pode gerar até {introPerMonth} por mês. Cada geração tem até duas tentativas, verificadas palavra a palavra; se não ficar pronta, os vídeos seguem sem introdução e o motivo aparece na página. Exige a sua fotografia, o direito a usá-la e a sua autorização para o Google Veo, e uma subscrição ativa, uma entrevista já enviada ou ser gestor de entidade.`,
      'introdução, introdução animada, boas-vindas, frase de boas-vindas, gerar introdução, oferecida, oferta, grátis, abertura do vídeo, intro'],
    en: ['What is the interviewer\'s animated introduction?',
      `It is free: in videos with Google Veo animation, right after the opening AI notice and before the title card, your photo appears animated saying a welcome phrase in English, with the visible notice «AI-generated video · AI voice». On the edit page, under «Introdução animada (Google Veo), oferecida» (Animated introduction, free), choose one of the three phrases (generic, with no names: your name appears as text, in the lower third) and press «Gerar introdução» (Generate introduction). It uses no credits and is not part of the quote. It is generated once and reused in all your interviews as long as the photo, the phrase, the voice, the Veo tier and the format do not change. You can generate up to {introPerMonth} per month. Each generation has up to two attempts, checked word by word; if it is not ready, the videos go ahead without the introduction and the reason is shown on the page. It needs your photo, the right to use it and your Google Veo permission, plus an active subscription, an interview already sent or being an entity manager.`,
      'introduction, animated introduction, welcome, welcome phrase, generate introduction, free, offer, video opening, intro'] },

  { key: 'custos', audience: 'interviewer',
    pt: ['Quanto custa processar uma entrevista? O que está incluído no plano?',
      `O plano inclui, em cada entrevista, a transcrição, o guião, a narração com vozes sintéticas, as legendas, a capa e o vídeo com fotografias e grafismo, com {includedRegens} regenerações do guião ou do episódio. Pagam-se à parte, com créditos: as entrevistas para além do plano ({extraInterviewCredits} créditos cada), as regenerações seguintes ({extraRegenCredits} crédito cada) e a animação por IA, sempre por orçamento aceite antes de gerar. A introdução animada é oferecida. Na produção, a estimativa do uso de IA e a «Utilização registada» são estimativas internas, não faturas. Os preços dos planos estão em «Conta».`,
      'custo, custos, estimativa, quanto custa, utilização registada, gastos, incluído, o que inclui, pago à parte, extra'],
    en: ['How much does processing an interview cost? What does the plan include?',
      `For each interview, the plan includes the transcription, the script, the narration with synthetic voices, the subtitles, the cover and the video with photos and graphics, with {includedRegens} regenerations of the script or episode. Paid separately, with credits: interviews beyond your plan ({extraInterviewCredits} credits each), further regenerations ({extraRegenCredits} credit each) and AI animation, always on a quote accepted before anything is generated. The animated introduction is free. On the production page, the AI usage estimate and the recorded usage («Utilização registada») are internal estimates, not invoices. Plan prices are on the «Conta» (Account) page.`,
      'cost, costs, estimate, how much, usage, spending, included, what is included, paid separately, extra'] },

  { key: 'creditos', audience: 'interviewer', sort: 282,
    pt: ['O que são os créditos e como os carrego?',
      `Os créditos pagam o que não está no plano: a animação por IA (por orçamento), as entrevistas extra e as regenerações para além das incluídas. Cada crédito vale um euro, sem IVA. Carregue na página «Créditos» (em inglês, «Credits»): escolha um pacote ou outro valor, de {topupMin} a {topupMax} créditos, e pague com cartão pela Stripe; antes, preencha os dados de faturação em «Conta». O IVA é cobrado e faturado no carregamento (fatura-recibo da vendedora, por email), nunca quando gasta os créditos. Cada carregamento vale {creditValidMonths} meses (avisamos por email 30 dias antes) e os créditos mais antigos gastam-se primeiro. Na mesma página vê o saldo disponível, o cativo nos orçamentos aceites, os carregamentos e o extrato. Os créditos são pessoais e intransmissíveis; o administrador não precisa deles.`,
      'créditos, crédito, carregar créditos, carregamento, comprar créditos, saldo, carteira, extrato, validade dos créditos, pacotes, recarregar'],
    en: ['What are credits and how do I top up?',
      `Credits pay for what the plan does not include: AI animation (on a quote), extra interviews and regenerations beyond the included ones. One credit is worth one euro, excluding VAT. Top up on the «Créditos» page («Credits»): choose a pack or another amount, from {topupMin} to {topupMax} credits, and pay by card through Stripe; first fill in your billing details in «Conta» (Account). VAT is charged and invoiced when you top up (an invoice-receipt from the seller, by email), never when you spend the credits. Each top-up is valid for {creditValidMonths} months (we email you 30 days before) and the oldest credits are used first. The same page shows your available balance, the amount held for accepted quotes, your top-ups and the statement. Credits are personal and cannot be transferred; administrators do not need them.`,
      'credits, credit, top up, top-up, buy credits, balance, wallet, statement, credit validity, packs, recharge'] },

  { key: 'devolucoes', audience: 'interviewer', sort: 284,
    pt: ['Como funcionam as devoluções e os reembolsos?',
      `Nos orçamentos da animação, o valor fica cativo e no fim só se cobram as falas animadas e verificadas: o resto volta ao saldo automaticamente, e uma produção que falhe ou seja anulada não custa nada. O crédito de uma regeneração extra que falhe também volta ao saldo. O saldo não usado de um carregamento pode ser reembolsado nos {refundDays} dias seguintes a esse carregamento (e sempre que o serviço encerre), para o mesmo cartão: peça-o ao suporte, nesta página de ajuda. Se comprar como consumidor, pode também desistir de cada carregamento nos {withdrawalDays} dias seguintes com «Desistir do contrato aqui», em «Créditos» (devolvemos o saldo ainda disponível desse carregamento), e de uma subscrição com o mesmo botão em «Conta»: a subscrição é cancelada de imediato e o valor pago, descontada a parte do serviço já prestada, é devolvido em 14 dias pelo mesmo meio de pagamento. Os termos têm o modelo de formulário de livre resolução.`,
      'devolução, devoluções, reembolso, reembolsar, devolver créditos, dinheiro de volta, livre resolução, desistir do contrato, cancelar subscrição, créditos devolvidos'],
    en: ['How do refunds work?',
      `In animation quotes, the amount is held and at the end only the lines that were animated and verified are charged: the rest goes back to your balance automatically, and a production that fails or is cancelled costs nothing. The credit for an extra regeneration that fails also goes back to your balance. The unused balance of a top-up can be refunded within {refundDays} days of that top-up (and always if the service closes), to the same card: ask support on this help page. If you buy as a consumer, you can also withdraw from each top-up within {withdrawalDays} days with «Desistir do contrato aqui» (Withdraw from the contract here), in «Créditos» (Credits) — we refund the balance still available on that top-up — and from a subscription with the same button in «Conta» (Account): the subscription is cancelled at once and the amount paid, less the part of the service already provided, is refunded within 14 days by the same payment method. The terms of sale include the model withdrawal form.`,
      'refund, refunds, money back, return credits, credits returned, right of withdrawal, withdraw from contract, cancel subscription, cooling off'] },

  { key: 'planos-conta', audience: 'interviewer',
    pt: ['Que planos há e como subscrevo ou mudo de plano?',
      `Há dois planos mensais, Start e Pro, que diferem no número de entrevistas por mês; os dois são só com imagens (fotografias, narração, legendas e o vídeo com fotografias) e a animação por IA paga-se à parte, por orçamento e com créditos. Abra «Conta» (página em inglês, «Your account»): preencha primeiro os dados de faturação, escolha o plano, aceite os termos e pague com cartão pela Stripe. Para mudar de plano, escolha o outro: a subscrição atual é alterada e a diferença proporcional é cobrada logo. Para o cartão, os recibos da Stripe e o cancelamento, use «Manage card, Stripe receipts & cancellation». As entrevistas contam-se pelos convites enviados no período e os preços em vigor estão nessa página. Quem tem um plano antigo (Starter ou Studio) mantém-no até mudar. Os gestores de entidade não precisam de subscrição. Se os pagamentos online ainda não estiverem ativos, fale com o suporte.`,
      'plano, planos, preços, subscrição, subscrever, mudar de plano, pagamento, cancelar subscrição, conta, limite de entrevistas, quota, Start, Pro'],
    en: ['Which plans are there, and how do I subscribe or change plan?',
      `There are two monthly plans, Start and Pro, which differ in the number of interviews per month; both are images only (photos, narration, subtitles and the video with photos), and AI animation is paid separately, on a quote and with credits. Open «Conta» (the «Your account» page): first fill in your billing details, choose the plan, accept the terms and pay by card through Stripe. To change plan, choose the other one: your current subscription is changed and the prorated difference is charged at once. For your card, Stripe receipts and cancellation, use «Manage card, Stripe receipts & cancellation». Interviews are counted by the invitations sent in the period, and current prices are on that page. If you have an older plan (Starter or Studio), you keep it until you change. Entity managers do not need a subscription. If online payments are not active yet, contact support.`,
      'plan, plans, prices, subscription, subscribe, change plan, payment, cancel subscription, account, interview limit, quota, Start, Pro'] },

  { key: 'faturas-iva', audience: 'interviewer', sort: 295,
    pt: ['Quem emite a fatura e como é calculado o IVA?',
      `A fatura-recibo de cada pagamento (subscrição ou carregamento de créditos) é emitida pela {sellerName} e enviada por email; os recibos da Stripe são só comprovativos de pagamento, e gastar créditos não tem fatura. Antes de pagar, preencha os dados de faturação em «Conta»: tipo de cliente (empresa ou particular), nome, NIF ou número de IVA e morada. O IVA segue a morada: em Portugal, a taxa do continente, da Madeira ou dos Açores; empresas de outros países da UE com o número de IVA confirmado no VIES não pagam IVA (autoliquidação); fora da UE, fale com o suporte nesta página. Aos particulares mostramos primeiro o preço com IVA.`,
      'fatura, faturas, fatura-recibo, recibo, IVA, NIF, número de IVA, dados de faturação, morada, autoliquidação, VIES, empresa, particular, consumidor'],
    en: ['Who issues the invoice, and how is VAT worked out?',
      `The invoice-receipt for each payment (subscription or credit top-up) is issued by {sellerName} and sent by email; Stripe receipts are only proof of payment, and spending credits has no invoice. Before paying, fill in your billing details in «Conta» (Account): customer type (business or private individual), name, NIF or VAT number and address. VAT follows the address: in Portugal, the mainland, Madeira or Azores rate; businesses in other EU countries with a VAT number confirmed in VIES pay no VAT (reverse charge); outside the EU, contact support on this page. Private customers see the price with VAT first.`,
      'invoice, invoices, invoice-receipt, receipt, VAT, NIF, VAT number, billing details, address, reverse charge, VIES, business, private individual, consumer'] },

  { key: 'palavra-passe', audience: 'interviewer',
    pt: ['Como altero a minha palavra-passe?',
      `Ainda não há alteração nem recuperação automática da palavra-passe na conta. Peça ao suporte nesta página: o administrador define uma palavra-passe nova (com pelo menos 12 caracteres) e todas as sessões abertas terminam, incluindo esta. A palavra-passe nova nunca é escrita nas mensagens do suporte: a entrega é combinada consigo por outro canal (o email da conta ou o telefone). Nunca escreva a sua palavra-passe nas mensagens.`,
      'palavra-passe, password, senha, esqueci, recuperar, alterar, mudar, entrar, iniciar sessão'],
    en: ['How do I change my password?',
      `There is no self-service password change or recovery yet. Ask support on this page: the administrator sets a new password (at least 12 characters) and all your open sessions end, including this one. The new password is never written in support messages: its delivery is arranged with you through another channel (your account email or phone). Never write your password in messages.`,
      'password, forgot, recover, reset, change, sign in, log in'] },

  { key: 'entidade', audience: 'interviewer',
    pt: ['O que faz um gestor de entidade? Precisa de subscrição?',
      `Um gestor de entidade convida sem subscrição e sem limite mensal de entrevistas (cada entrevista mantém os limites de tempo, de perguntas e de regenerações; as regenerações extra pagam-se com créditos). Gere também a página «Entidade», com as chaves de serviço próprias da sua entidade (OpenAI, Stripe, MailerSend, Moloni ON, Replicate, fal.ai, WaveSpeed e Google). As chaves da entidade têm prioridade sobre as do portal; sem chave própria, usa-se a do portal. Com credenciais Google próprias (conta de serviço do Vertex AI ou chave Gemini), a animação com o Google Veo pedida pelo gestor não usa orçamento nem créditos: a Google cobra no projeto da entidade; com as do portal, é por orçamento, como para os outros. As chaves ficam cifradas e nunca voltam a ser mostradas por inteiro: deixe o campo em branco para manter, escreva «-» para apagar e use «Guardar e testar» para confirmar.`,
      'entidade, gestor de entidade, chaves, API, empresa, organização, credenciais, chaves próprias'],
    en: ['What does an entity manager do? Do they need a subscription?',
      `An entity manager invites without a subscription and with no monthly interview limit (each interview keeps its time, question and regeneration limits; extra regenerations are paid with credits). They also look after the «Entidade» (Entity) page, with the entity's own service keys (OpenAI, Stripe, MailerSend, Moloni ON, Replicate, fal.ai, WaveSpeed and Google). The entity's keys take priority over the portal's; without its own key, the portal's is used. With its own Google credentials (a Vertex AI service account or a Gemini key), Google Veo animation requested by the manager uses no quote and no credits: Google bills the entity's project; with the portal's credentials, it is on a quote, as for everyone else. Keys are stored encrypted and never shown in full again: leave a field blank to keep it, type «-» to delete it and use «Guardar e testar» (Save and test) to check.`,
      'entity, entity manager, keys, API, company, organisation, credentials, own keys'] },

  { key: 'assistente-privacidade', audience: 'interviewer',
    pt: ['O que acontece às perguntas que faço ao assistente?',
      `Ficam registadas durante {logDays} dias sem ligação a si (sem conta, entidade nem endereço IP; emails, links e números longos são tapados), para a equipa do portal melhorar as respostas. A resposta vem sempre destas perguntas frequentes. Com uma subscrição ativa ou como gestor de entidade, e se o portal tiver a IA ligada, o texto da pergunta (só ele) pode ser enviado a um fornecedor de IA externo (OpenAI) para redigir uma resposta curta a partir delas. Não escreva dados pessoais nem palavras-passe.`,
      'assistente, perguntas ao assistente, registo, privacidade, dados, IA, OpenAI, inteligência artificial, quem vê as perguntas, guarda as perguntas, guardar, armazenar, armazenam, registo das perguntas'],
    en: ['What happens to the questions I ask the assistant?',
      `They are stored for {logDays} days with no link to you (no account, entity or IP address; emails, links and long numbers are masked), so the portal team can improve the answers. The answer always comes from these frequently asked questions. With an active subscription or as an entity manager, and if the portal has AI switched on, the text of the question alone may be sent to an external AI provider (OpenAI) to draft a short answer from them. Do not write personal data or passwords.`,
      'assistant, questions to the assistant, log, privacy, data, AI, OpenAI, artificial intelligence, who sees my questions, store, stored'] },

  { key: 'suporte-portal', audience: 'interviewer',
    pt: ['Como falo com o suporte?',
      `Nesta página, em «Falar com o suporte», escreva a mensagem (até 5000 caracteres) e carregue em «Enviar ao suporte». A equipa do portal responde aqui, não por email: a ligação «Ajuda» no topo mostra quantas respostas tem por ler. Pode responder, fechar e reabrir cada pedido, e enviar até 10 mensagens por hora. Não inclua palavras-passe nem dados de pagamento.`,
      'suporte, ajuda, contactar, falar com alguém, pessoa, humano, problema, erro, reclamação, pedido de ajuda'],
    en: ['How do I contact support?',
      `On this page, under «Falar com o suporte» (Contact support), write your message (up to 5000 characters) and press «Enviar ao suporte» (Send to support). The portal team replies here, not by email: the «Ajuda» (Help) link at the top shows how many replies you have not read. You can reply, close and reopen each request, and send up to 10 messages per hour. Do not include passwords or payment details.`,
      'support, help, contact, talk to someone, person, human, problem, error, complaint, help request'] },

  // ======================= convidados =======================
  { key: 'convidado-como-funciona', audience: 'guest',
    pt: ['Como funciona a entrevista?',
      `Responde às perguntas no telemóvel ou no computador, quando lhe der jeito, sem instalar nada nem criar conta. Primeiro escolhe o que autoriza; depois, em cada pergunta, ouve-a, grava a resposta e pode ouvi-la e repeti-la. No fim pode juntar fotografias (é opcional), revê tudo e submete. A partir das suas respostas, o entrevistador prepara um episódio de podcast em inglês.`,
      'como funciona, o que é isto, entrevista, passos, começar, o que tenho de fazer'],
    en: ['How does the interview work?',
      `You answer the questions on your phone or computer, whenever suits you, with nothing to install and no account. First you choose what you allow; then, for each question, you listen to it, record your answer and can play it back and redo it. At the end you can add photos (optional), review everything and submit. From your answers, the interviewer prepares an English-language podcast episode.`,
      'how it works, what is this, interview, steps, start, what do I do'] },

  { key: 'convidado-instalar', audience: 'guest',
    pt: ['Preciso de instalar alguma aplicação ou criar conta?',
      `Não. Basta abrir o link pessoal do email no navegador do telemóvel ou do computador. O link é pessoal: não o partilhe.`,
      'instalar, aplicação, app, criar conta, registar, telemóvel, computador, navegador'],
    en: ['Do I need to install an app or create an account?',
      `No. Just open the personal link from the email in the browser on your phone or computer. The link is personal: do not share it.`,
      'install, app, application, create account, sign up, phone, computer, browser'] },

  { key: 'convidado-gravar', audience: 'guest',
    pt: ['Como gravo uma resposta?',
      `Na página da pergunta, carregue em «Gravar resposta», fale e carregue em «Parar». A resposta é enviada e aparece «Guardado no servidor»; pode ouvi-la no leitor. Depois carregue em «Confirmar e continuar». O navegador pede autorização para usar o microfone: aceite. Antes de gravar, pare qualquer outro áudio (música, vídeo). Pode ouvir a pergunta em «Ouvir pergunta».`,
      'gravar, gravação, como gravo, botão, responder, parar, ouvir pergunta'],
    en: ['How do I record an answer?',
      `On the question page, press «Record answer», speak and press «Stop». The answer is uploaded and «Saved on the server» appears; you can play it back. Then press «Confirm and continue». Your browser asks for permission to use the microphone: allow it. Before recording, stop any other audio (music, video). You can hear the question with «Listen to the question».`,
      'record, recording, how to record, button, answer, stop, listen to question'] },

  { key: 'convidado-duracao', audience: 'guest',
    pt: ['Quanto tempo pode ter cada resposta?',
      `Cada resposta pode ter até {maxAnswerMin} minutos. A entrevista também pode ter um tempo total para todas as respostas: nesse caso, a página mostra o «Tempo restante» e a gravação para sozinha quando o tempo acaba. Um ficheiro de áudio carregado acima do limite é recusado.`,
      'tempo, duração, minutos, limite, quanto tempo, comprida, longa, máximo, tempo restante, tempo total'],
    en: ['How long can each answer be?',
      `Each answer can be up to {maxAnswerMin} minutes. The interview may also have a total time for all your answers: if so, the page shows the «Time left» and the recording stops by itself when the time runs out. An uploaded audio file above the limit is refused.`,
      'time, duration, minutes, limit, how long, length, maximum, time left, total time'] },

  { key: 'convidado-regravar', audience: 'guest',
    pt: ['Posso gravar de novo uma resposta?',
      `Sim. Enquanto não submeter a entrevista, pode voltar a qualquer pergunta e carregar em «Repetir» para gravar outra vez; fica a gravação mais recente. Depois de submeter, só pode alterar contactando quem o convidou.`,
      'repetir, regravar, gravar de novo, mudar resposta, corrigir resposta, apagar resposta, outra vez'],
    en: ['Can I record an answer again?',
      `Yes. Until you submit the interview, you can go back to any question and press «Redo» to record again; the latest recording is kept. After submitting, you can only change things by contacting the interviewer.`,
      'redo, record again, re-record, change answer, correct answer, delete answer'] },

  { key: 'convidado-recusar-pergunta', audience: 'guest',
    pt: ['Posso não responder a uma pergunta?',
      `Sim. Na página da pergunta, carregue em «Não pretendo responder». Fica registado que não quis responder e passa à pergunta seguinte. Se mudar de ideias antes de submeter, volte à pergunta e grave a resposta.`,
      'não responder, recusar pergunta, saltar pergunta, passar à frente, prefiro não, ignorar'],
    en: ['Can I skip a question?',
      `Yes. On the question page, press «I prefer not to answer». It is recorded that you chose not to answer, and you move on to the next question. If you change your mind before submitting, go back to the question and record your answer.`,
      'skip question, not answer, decline question, prefer not, pass'] },

  { key: 'convidado-microfone', audience: 'guest',
    pt: ['O microfone não funciona. O que faço?',
      `Confirme nas definições do navegador que esta página pode usar o microfone e que nenhuma outra aplicação o está a usar. Se o acesso foi recusado ou não houver microfone, pode gravar a resposta noutra aplicação e usar «Carregar um áudio já gravado». Se a gravação ficar vazia ou silenciosa, a página avisa e pode repetir.`,
      'microfone, não funciona, não grava, sem som, microfone bloqueado, acesso ao microfone, erro, silêncio'],
    en: ['The microphone does not work. What can I do?',
      `Check in your browser settings that this page may use the microphone and that no other app is using it. If access was refused or there is no microphone, you can record your answer in another app and use «Upload an existing recording». If a recording is empty or silent, the page tells you and you can redo it.`,
      'microphone, not working, does not record, no sound, microphone blocked, microphone access, error, silent'] },

  { key: 'convidado-carregar-audio', audience: 'guest',
    pt: ['Posso enviar um áudio que já gravei?',
      `Sim. Na página da pergunta, abra «Carregar um áudio já gravado» e escolha o ficheiro. O portal verifica que é um áudio válido e com som; a duração máxima é a mesma das gravações ({maxAnswerMin} minutos) e conta para o tempo total da entrevista, se houver.`,
      'carregar áudio, ficheiro, áudio gravado, enviar áudio, upload'],
    en: ['Can I upload a recording I already made?',
      `Yes. On the question page, open «Upload an existing recording» and choose the file. The portal checks that it is valid audio with sound; the maximum length is the same as for recordings ({maxAnswerMin} minutes) and it counts towards the interview's total time, if there is one.`,
      'upload audio, file, recorded audio, send audio'] },

  { key: 'convidado-continuar', audience: 'guest',
    pt: ['Posso parar e continuar mais tarde?',
      `Sim. Cada resposta fica guardada assim que aparece «Guardado no servidor». Carregue em «Guardar e sair» e, mais tarde, abra de novo o link do email: continua onde ficou, até à data indicada no convite. Também pode continuar noutro dispositivo, abrindo lá o mesmo link.`,
      'parar, continuar mais tarde, guardar e sair, voltar, outro dispositivo, pausa, mais tarde, até quando, prazo'],
    en: ['Can I stop and continue later?',
      `Yes. Each answer is saved as soon as «Saved on the server» appears. Press «Save and leave» and, later, open the link from the email again: you continue where you left off, until the date given in the invitation. You can also continue on another device by opening the same link there.`,
      'stop, continue later, save and leave, come back, other device, pause, later, until when, deadline'] },

  { key: 'convidado-link', audience: 'guest',
    pt: ['O meu link expirou ou não funciona. O que faço?',
      `Na página do link expirado, escreva o email para onde recebeu o convite e carregue em «Enviar novo link»: se corresponder ao convite, recebe um link novo por email. Também pode pedir um novo convite a quem o convidou. Cada novo link anula o anterior.`,
      'link expirou, expirado, não funciona, link inválido, novo link, revogado, não abre'],
    en: ['My link has expired or does not work. What can I do?',
      `On the expired-link page, enter the email address where you received the invitation and press «Send a new link»: if it matches the invitation, you receive a new link by email. You can also ask the person who invited you for a new invitation. Each new link cancels the previous one.`,
      'link expired, expired, not working, invalid link, new link, revoked, does not open'] },

  { key: 'convidado-autorizacoes', audience: 'guest',
    pt: ['O que estou a autorizar?',
      `Antes de começar escolhe, uma a uma e sem nada pré-selecionado: a participação e a gravação das respostas (necessária, com a confirmação de ter 18 anos ou mais), o tratamento por IA (transcrição, tradução para inglês e narração com vozes sintéticas, por serviços externos) e a publicação do episódio. As fotografias e cada uso delas (capa, publicação, animação por IA e vídeo IA) são autorizações à parte, pedidas no fim. Pode recusar tudo o que não seja necessário para participar.`,
      'autorizações, consentimento, autorizar, o que autorizo, permissões, dados, 18 anos'],
    en: ['What am I allowing?',
      `Before you start you choose, one by one and with nothing pre-ticked: taking part and recording your answers (needed, with confirmation that you are 18 or older), AI processing (transcription, translation into English and narration with synthetic voices, by external services) and publication of the episode. Photos and each use of them (cover, publication, AI animation and AI video) are separate permissions, asked for at the end. You may refuse anything that is not needed to take part.`,
      'permissions, consent, allow, what do I allow, data, 18'] },

  { key: 'convidado-voz', audience: 'guest',
    pt: ['A minha voz vai ser usada no episódio?',
      `O episódio é produzido em inglês e narrado com vozes sintéticas geradas por IA, identificadas como tal; a sua voz não é clonada. Se autorizar o vídeo IA, nas falas animadas pelo Google Veo a voz é gerada pelo próprio modelo, também sem usar a sua. As suas gravações originais ficam privadas.`,
      'minha voz, voz, clonar, clonagem, voz sintética, narração, inglês'],
    en: ['Will my voice be used in the episode?',
      `The episode is produced in English and narrated with AI-generated synthetic voices, labelled as such; your voice is not cloned. If you allow AI video, in the lines animated by Google Veo the voice is generated by the model itself, again without using yours. Your original recordings stay private.`,
      'my voice, voice, clone, cloning, synthetic voice, narration, English'] },

  { key: 'convidado-fotografias', audience: 'guest',
    pt: ['Tenho de enviar fotografias?',
      `Não, são opcionais. No fim pode tirar até três selfies com a câmara ou carregar fotografias, só se autorizar a captação. Cada uso é uma autorização à parte: capa do episódio, publicação, animação por IA e vídeo IA. Os metadados das fotografias JPEG (como a localização) são removidos. Pode descartar uma fotografia antes de submeter e alterar as autorizações mais tarde em «Autorizações das fotografias».`,
      'fotografias, fotos, minha fotografia, selfie, câmara, imagem, obrigatório, localização, opcional'],
    en: ['Do I have to send photos?',
      `No, they are optional. At the end you can take up to three selfies with the camera or upload photos, only if you allow capture. Each use is a separate permission: episode cover, publication, AI animation and AI video. Metadata in JPEG photos (such as location) is removed. You can discard a photo before submitting and change the permissions later under «Photo permissions».`,
      'photos, photo, my photo, selfie, camera, picture, required, location, optional'] },

  { key: 'convidado-video-ia', audience: 'guest',
    pt: ['Vou aparecer num vídeo animado por IA?',
      `Só se der a autorização específica para isso, em «Autorizações das fotografias»; no vídeo do Google Veo, só quando o entrevistador escolheu que o entrevistado vê e aprova a versão final. Um vídeo em que apareça animado por IA leva sempre um aviso visível e só é publicado depois de o ver e aprovar. Se retirar a autorização, os vídeos do episódio em que aparece animado deixam de ser mostrados e são apagados, tal como os clipes do Google Veo com a sua imagem; os clipes do retrato animado ficam guardados em privado até pedir ao suporte, nesta página, que os apague.`,
      'vídeo, animação, IA, animado, Veo, avatar, retrato animado, a minha imagem'],
    en: ['Will I appear in an AI-animated video?',
      `Only if you give the specific permission for it, under «Photo permissions»; in the Google Veo video, only when the interviewer chose that the guest sees and approves the final version. A video in which you appear animated by AI always carries a visible notice and is only published after you have seen and approved it. If you withdraw the permission, the episode videos in which you appear animated are no longer shown and are deleted, together with the Google Veo clips of you; the animated-portrait clips are kept privately until you ask support, on this page, to delete them.`,
      'video, animation, AI, animated, Veo, avatar, animated portrait, my image'] },

  { key: 'convidado-nome-video', audience: 'guest', sort: 145,
    pt: ['O meu nome aparece no vídeo?',
      `Sim, em texto: no cartão de título, no início do vídeo («with» e o seu nome), e num rodapé com o seu nome e a função indicada pelo entrevistador, na primeira vez que aparece a falar. A sua fotografia só entra no vídeo se autorizar a publicação dela.`,
      'nome, o meu nome, nome no vídeo, rodapé, função, cartão de título, texto no vídeo, aparece'],
    en: ['Does my name appear in the video?',
      `Yes, as text: on the title card at the start of the video («with» and your name), and in a lower third with your name and the role given by the interviewer, the first time you are shown speaking. Your photo is only used in the video if you allow its publication.`,
      'name, my name, name in video, lower third, role, title card, text in video, shown'] },

  { key: 'convidado-submeter', audience: 'guest',
    pt: ['Como termino e submeto a entrevista?',
      `Quando todas as perguntas estiverem respondidas ou recusadas, abra «Rever e submeter», confira as respostas, as fotografias e as autorizações e carregue em «Submeter entrevista». Recebe um comprovativo na página. Depois de submeter, só pode alterar contactando quem o convidou.`,
      'submeter, terminar, concluir, enviar respostas, acabar, comprovativo, finalizar, rever'],
    en: ['How do I finish and submit the interview?',
      `When every question is answered or declined, open «Review and submit», check your answers, photos and permissions and press «Submit interview». You get a receipt on the page. After submitting, you can only change things by contacting the interviewer.`,
      'submit, finish, complete, send answers, done, receipt, review'] },

  { key: 'convidado-aprovar', audience: 'guest',
    pt: ['Como vejo e aprovo o episódio?',
      `Quando a sua aprovação conta (por omissão, e sempre que aparece animado por IA num vídeo), o entrevistador envia-lhe um email com um link para a pré-visualização: aí vê e ouve o episódio e escolhe «Aprovo esta versão» ou «Quero pedir alterações», com uma nota. O silêncio nunca conta como aprovação. Se o vídeo mudar depois de abrir a página, tem de ver a versão nova antes de aprovar. Quando a publicação é decidida pelo entrevistador, o link serve só para ver o episódio. Num episódio já publicado, vê e ouve com a data de publicação; para pedir uma correção ou a retirada, use a ligação «Pedir uma correção ou a retirada do episódio» (abre o formulário de contacto do portal com o episódio preenchido) ou contacte quem o convidou.`,
      'aprovar, episódio, pré-visualização, validar, ver episódio, pedir alterações, ouvir episódio'],
    en: ['How do I see and approve the episode?',
      `When your approval counts (by default, and always when you appear animated by AI in a video), the interviewer sends you an email with a link to the preview. There you watch and listen to the episode and choose «I approve this version» or «I want to request changes», with a note. Silence never counts as approval. If the video changes after you open the page, you need to see the new version before approving. When publication is decided by the interviewer, the link is only for watching the episode. On an episode already published, you watch and listen with the publication date; to ask for a correction or for it to be withdrawn, use the link «Ask for a correction or the withdrawal of the episode» (it opens the portal’s contact form with the episode filled in) or contact the person who invited you.`,
      'approve, episode, preview, validate, see episode, request changes, listen to episode'] },

  { key: 'convidado-publicacao', audience: 'guest',
    pt: ['Quem decide a publicação e quem pode ouvir o episódio?',
      `Depende da política escolhida pelo entrevistador, indicada nas autorizações: por omissão, nada é publicado sem a sua aprovação da versão final; noutros casos a publicação é decidida pelo entrevistador, mas um vídeo em que apareça animado por IA precisa sempre da sua aprovação. Sem a sua autorização de publicação, o episódio não é publicado. Um episódio publicado pode ser privado, acessível só a quem tem o link, ou público.`,
      'publicação, publicar, quem decide, público, privado, quem ouve, partilhar'],
    en: ['Who decides on publication, and who can listen to the episode?',
      `It depends on the policy chosen by the interviewer, shown in the permissions: by default, nothing is published without your approval of the final version; otherwise publication is decided by the interviewer, but a video in which you appear animated by AI always needs your approval. Without your publication permission, the episode is not published. A published episode can be private, available only to people with the link, or public.`,
      'publication, publish, who decides, public, private, who listens, share'] },

  { key: 'convidado-privacidade', audience: 'guest',
    pt: ['Quem tem acesso às minhas respostas? Posso pedir que apaguem os meus dados?',
      `As gravações originais e as fotografias não usadas ficam privadas: só o entrevistador e a equipa do portal (para suporte) lhes têm acesso. Com a sua autorização, o áudio é enviado a um fornecedor de IA para transcrição, tradução e narração. Pode pedir acesso, correção, retirada de autorização ou eliminação ao suporte, nesta página; depois de o link deixar de valer, use o formulário de contacto do portal (ligação «Contact» no fundo de cada página). As perguntas que escreve no assistente desta página são respondidas só com as perguntas frequentes (não seguem para serviços de IA) e ficam registadas sem identificação durante {logDays} dias. Cópias já descarregadas ou distribuídas fora do portal podem não ser recuperáveis.`,
      'privacidade, dados, apagar, eliminar, quem vê, acesso, RGPD, retirar autorização, dados pessoais'],
    en: ['Who can access my answers? Can I ask for my data to be deleted?',
      `The original recordings and unused photos stay private: only the interviewer and the portal team (for support) can access them. With your permission, the audio is sent to an AI provider for transcription, translation and narration. You can ask support, on this page, for access, correction, withdrawal of consent or deletion; once your link is no longer valid, use the portal’s contact form (the «Contact» link at the bottom of every page). Questions you type into the assistant on this page are answered only from the frequently asked questions (they are not sent to AI services) and are stored without identification for {logDays} days. Copies already downloaded or distributed outside the portal may not be recoverable.`,
      'privacy, data, delete, erase, who sees, access, GDPR, withdraw consent, personal data'] },

  { key: 'convidado-lingua', audience: 'guest',
    pt: ['Em que língua respondo?',
      `Responda na sua língua, com naturalidade. As páginas estão na língua escolhida pelo entrevistador (português ou inglês). O episódio final é em inglês, com vozes sintéticas, e pode ter legendas em várias línguas.`,
      'língua, idioma, português, inglês, que língua, traduzir, tradução'],
    en: ['Which language should I answer in?',
      `Answer in your own language, naturally. The pages are in the language chosen by the interviewer (Portuguese or English). The final episode is in English, with synthetic voices, and may have subtitles in several languages.`,
      'language, Portuguese, English, which language, translate, translation'] },

  { key: 'convidado-recusar', audience: 'guest',
    pt: ['Não quero participar. Como recuso o convite?',
      `Abra o link do convite e escolha «Não pretendo participar». Fica registado e quem o convidou é avisado por email. Não precisa de dar justificação.`,
      'recusar, não quero participar, desistir, não participar, declinar, recusar convite'],
    en: ['I do not want to take part. How do I decline?',
      `Open the invitation link and choose «I do not wish to take part». It is recorded and the person who invited you is told by email. You do not need to give a reason.`,
      'decline, do not want to take part, opt out, not participate, refuse invitation'] },

  { key: 'convidado-suporte', audience: 'guest',
    pt: ['Como falo com o suporte?',
      `Nesta página, em «Falar com o suporte», escreva a mensagem e carregue em «Enviar ao suporte». A equipa do portal responde aqui, não por email: para ler a resposta, volte a esta página pelo link do convite enquanto for válido; a ligação «Ajuda» mostra quando há respostas por ler. Se o convite for cancelado ou recusado, ainda pode ler as respostas no navegador onde o abriu, até ao fim do prazo do convite, mas já não pode escrever: para um pedido novo, use o formulário de contacto do portal (ligação «Contact» no fundo de cada página). Para alterar respostas já submetidas, contacte também quem o convidou.`,
      'suporte, ajuda, contactar, falar com alguém, problema, erro, dúvida, pessoa'],
    en: ['How do I contact support?',
      `On this page, under «Contact support», write your message and press «Send to support». The portal team replies here, not by email: to read the reply, come back to this page through your invitation link while it is valid; the «Help» link shows when there are unread replies. If the invitation is cancelled or declined, you can still read the replies in the browser where you opened it, until the invitation deadline, but you can no longer write: for a new request, use the portal’s contact form (the «Contact» link at the bottom of every page). To change answers you have already submitted, also contact the interviewer.`,
      'support, help, contact, talk to someone, problem, error, question, person'] },

  // ======================= todos =======================
  { key: 'quem-gere', audience: 'all',
    pt: ['Quem gere e quem comercializa o {brand}?',
      `O {brand} é propriedade da {ownerName}, que o gere (identificada no rodapé de todas as páginas). O serviço é comercializado (vendido ao cliente final) pela {sellerName}, identificada com o NIF, a morada e o Livro de Reclamações nas páginas de compra (conta, créditos e carregamentos), nos termos e condições e nos orçamentos da animação.`,
      'quem gere, gestora, proprietário, dono, dono do portal, quem vende, comercializa, empresa, NIF, livro de reclamações, Certif, Telecert, responsável, portal, site, plataforma'],
    en: ['Who operates and who sells {brand}?',
      `{brand} is owned and operated by {ownerName} (identified in the footer of every page). The service is sold to end customers by {sellerName}, identified with its tax number, address and complaints book on the purchase pages (account, credits and top-ups), in the terms of sale and in the animation quotes.`,
      'who operates, operator, owner, owns, runs, run, behind, who sells, seller, company, VAT, complaints book, Certif, Telecert, responsible, portal, website, site, platform'] },
];

// ---------------- versões das entradas ----------------

/** Texto como o formulário do administrador o guarda (espaços da pergunta e das palavras-chave, quebras de linha da resposta). */
export const faqNorm = {
  line: (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim(),
  answer: (s: unknown) => String(s ?? '').replace(/\r\n?/g, '\n').trim(),
};

/** Impressão de uma versão de uma entrada (chave, língua, público, pergunta, resposta e palavras-chave). */
export const seedHash = (key: string, lang: string, e: { audience: string; question: string; answer: string; keywords: string }) =>
  sha256(JSON.stringify([key, lang, e.audience, faqNorm.line(e.question), faqNorm.answer(e.answer), faqNorm.line(e.keywords)])).slice(0, 24);

export interface SeedRow { key: string; lang: 'pt' | 'en'; audience: FaqAudience; question: string; answer: string; keywords: string; sort: number; hash: string }

/** Linhas da semente (uma por entrada e língua), com a ordem e a impressão da versão atual. */
export function seedRows(): SeedRow[] {
  const rows: SeedRow[] = [];
  const order: Record<string, number> = {};
  for (const e of FAQ_SEED) {
    // As entradas sem ordem explícita numeram-se como na primeira semente (10, 20, …; «todos» depois de 900).
    const sort = e.sort ?? (order[e.audience] = (order[e.audience] ?? 0) + 10) + (e.audience === 'all' ? 900 : 0);
    for (const lang of ['pt', 'en'] as const) {
      const [question, answer, keywords] = e[lang];
      rows.push({ key: e.key, lang, audience: e.audience, question, answer, keywords, sort, hash: seedHash(e.key, lang, { audience: e.audience, question, answer, keywords }) });
    }
  }
  return rows;
}

/** Versão atual da semente por entrada e língua (`chave/língua`). */
export const seedIndex = () => new Map(seedRows().map(r => [`${r.key}/${r.lang}`, r]));

/** Marca de uma entrada antiga alterada pelo administrador sem versão publicada conhecida (nunca é igual a uma impressão). */
const UNKNOWN_BASE = '-';

/**
 * Estado de uma entrada da base face à semente. `edited`: o administrador mudou o texto (já não é igual à versão em que
 * a entrada se baseia, seed_hash, nem, nas entradas de antes das versões, a nenhuma das versões publicadas) e ele não é
 * igual ao texto atual da semente. `newer`: a semente tem um texto diferente daquele em que a alteração se baseou
 * (atualização por decidir pelo administrador). `current`: a versão atual da semente (undefined se a chave saiu dela).
 */
export function seedState(row: { seed_key?: string | null; lang: string; audience: string; question: string; answer: string; keywords: string; seed_hash?: string | null },
  index = seedIndex()) {
  if (!row.seed_key) return null;
  const now = seedHash(row.seed_key, row.lang, row);
  const legacy = LEGACY_SEED_HASHES[`${row.seed_key}/${row.lang}`] ?? [];
  const current = index.get(`${row.seed_key}/${row.lang}`);
  const edited = now !== current?.hash && (row.seed_hash ? now !== row.seed_hash : !legacy.includes(now));
  const base = row.seed_hash ?? (edited ? legacy.at(-1) ?? UNKNOWN_BASE : now);
  return { now, edited, base, current, newer: edited && !!current && base !== current.hash };
}

/**
 * Semente na base: insere as entradas em falta e atualiza as que o administrador não alterou (texto igual à versão que
 * a semente escreveu, ou, nas entradas de antes das versões, a uma das versões publicadas); as alterações dele ficam, e
 * a ordem e o estado (ativa/inativa) nunca mudam. Cada atualização só se aplica se o texto não mudou entretanto.
 */
export async function seedAssistant(db: Db) {
  const want = seedRows(), index = new Map(want.map(r => [`${r.key}/${r.lang}`, r]));
  const values = want.map((_, i) => `($${i * 8 + 1},$${i * 8 + 2},$${i * 8 + 3},$${i * 8 + 4},$${i * 8 + 5},$${i * 8 + 6},$${i * 8 + 7},$${i * 8 + 8})`).join(',');
  const inserted = await db.query(`INSERT INTO assistant_faq(seed_key, lang, audience, question, answer, keywords, sort, seed_hash) VALUES ${values}
    ON CONFLICT (seed_key, lang) DO NOTHING RETURNING id`, want.flatMap(r => [r.key, r.lang, r.audience, r.question, r.answer, r.keywords, r.sort, r.hash]));
  let updated = 0, kept = 0;
  const rows = await db.query(`SELECT id, seed_key, lang, audience, question, answer, keywords, seed_hash FROM assistant_faq WHERE seed_key IS NOT NULL`);
  for (const r of rows) {
    const st = seedState(r, index)!;
    if (!st.current) continue; // a chave saiu da semente: a entrada fica como está
    const same = 'id=$1 AND audience=$2 AND question=$3 AND answer=$4 AND keywords=$5', was = [r.id, r.audience, r.question, r.answer, r.keywords];
    if (st.edited) {
      kept++;
      // Entrada de antes das versões alterada pelo administrador: fica registada a versão em que a alteração se baseou.
      if (!r.seed_hash) await db.query(`UPDATE assistant_faq SET seed_hash=$6 WHERE ${same} AND seed_hash IS NULL`, [...was, st.base]);
    } else if (st.now !== st.current.hash) {
      const c = st.current;
      if (await db.one(`UPDATE assistant_faq SET audience=$6, question=$7, answer=$8, keywords=$9, seed_hash=$10, updated_at=now() WHERE ${same} RETURNING id`,
        [...was, c.audience, c.question, c.answer, c.keywords, c.hash])) updated++;
    } else if (r.seed_hash !== st.current.hash) {
      await db.query(`UPDATE assistant_faq SET seed_hash=$6 WHERE ${same}`, [...was, st.current.hash]);
    }
  }
  return { inserted: inserted.length, updated, kept };
}

/**
 * Decisão do administrador sobre uma entrada da semente que ele alterou: `restore` repõe o texto atual da semente;
 * `keep` mantém o texto dele e dá a versão atual da semente como vista (deixa de aparecer como atualização por decidir).
 * Devolve null se a chave saiu da semente.
 */
export async function resolveSeed(db: Db, id: string, how: 'restore' | 'keep') {
  const r = await db.one('SELECT seed_key, lang FROM assistant_faq WHERE id=$1', [id]);
  const c = r?.seed_key ? seedIndex().get(`${r.seed_key}/${r.lang}`) : undefined;
  if (!c) return null;
  if (how === 'keep') await db.query('UPDATE assistant_faq SET seed_hash=$2 WHERE id=$1', [id, c.hash]);
  else await db.query(`UPDATE assistant_faq SET audience=$2, question=$3, answer=$4, keywords=$5, seed_hash=$6, updated_at=now() WHERE id=$1`, [id, c.audience, c.question, c.answer, c.keywords, c.hash]);
  return c;
}
