export type Lang = 'pt-PT' | 'en';
export const normLang = (l?: string): Lang => (l === 'en' ? 'en' : 'pt-PT');

const D = {
  'pt-PT': {
    inviteTitle: 'Convite para uma entrevista',
    invitedBy: (h: string) => `${h} convida-o(a) a responder a uma entrevista.`,
    qCount: (n: number) => `${n} pergunta${n === 1 ? '' : 's'} · pode responder no telemóvel, quando quiser`,
    open: 'Abrir entrevista', decline: 'Não pretendo participar', declined: 'Registámos que não pretende participar. Obrigado pela resposta.',
    expired: 'Este link expirou ou foi revogado', expiredHelp: 'Peça um novo convite a quem o convidou, ou indique o seu email para receber um novo link.',
    resendBtn: 'Enviar novo link', resendDone: 'Se o email corresponder a um convite, enviámos um novo link.', yourEmail: 'O seu email',
    beforeStart: 'Antes de começar', objective: 'Objetivo da entrevista',
    consentIntro: 'Escolha o que autoriza. Nada está pré-selecionado. Pode recusar tudo o que não seja necessário para participar.',
    c_participation: 'Participação e gravação das minhas respostas (necessário para responder).',
    c_processing: 'Transcrição, tradução para inglês e narração com vozes sintéticas geradas por IA, através de serviços externos.',
    c_publish: 'Publicação do episódio resultante, depois de eu o ter visto e aprovado.',
    consentLong: 'Quem organiza: o entrevistador indicado no convite. Finalidades: gravar as suas respostas, transcrevê-las, traduzi-las e produzir um episódio de podcast em inglês com vozes sintéticas (não clonamos a sua voz). Serviços externos: transcrição, tradução e voz sintética são feitos por um fornecedor de IA. Publicação: só após a sua aprovação do resultado. Conservação: os originais ficam privados e pode pedir a sua eliminação através do contacto de apoio.',
    adults: 'Confirmo que tenho 18 anos ou mais.',
    save: 'Guardar e continuar', start: 'Começar', continue: 'Continuar',
    question: 'Pergunta', of: 'de', listen: 'Ouvir pergunta', listenSynth: 'Leitura feita com voz gerada por IA.', record: 'Gravar resposta', stop: 'Parar', hear: 'Ouvir resposta',
    redo: 'Repetir', confirm: 'Confirmar e continuar', saveExit: 'Guardar e sair', refuse: 'Não pretendo responder', uploadOwn: 'Carregar um áudio já gravado',
    stLocal: 'Gravado neste dispositivo', stUp: 'A enviar…', stSaved: 'Guardado no servidor', stFail: 'Falhou o envio. Pode tentar de novo.', retry: 'Tentar de novo',
    micDenied: 'O acesso ao microfone foi recusado. Pode carregar um áudio já gravado.', micNone: 'Não foi encontrado nenhum microfone.', empty: 'A gravação ficou vazia. Tente novamente.',
    silent: 'A gravação parece silenciosa. Pode repetir ou continuar mesmo assim.', tooLong: 'A gravação excede o limite.', otherAudio: 'Pare qualquer outro áudio (música, vídeo) antes de gravar.',
    refused: 'Registou que não pretende responder a esta pergunta.', answered: 'Resposta guardada',
    photos: 'Fotografias (opcional)', photosIntro: 'Pode tirar até três selfies à sua escolha para acompanhar a entrevista. Só usamos as que escolher, e só nas finalidades que autorizar.',
    c_photo: 'Autorizo a captação e o armazenamento das fotografias que eu escolher.', c_cover: 'Autorizo a utilização de uma ou mais fotografias na capa do episódio.', c_pubphoto: 'Autorizo a publicação dessas fotografias no episódio.', c_animate: 'Autorizo que uma dessas fotografias seja animada por IA no vídeo do episódio (movimento da boca sincronizado com a voz sintética em inglês), sempre com o aviso visível «Retrato animado por IA».', versionChanged: 'O vídeo mudou desde que abriu esta página: veja a versão atual antes de aprovar.', c_aivideo: 'Autorizo que uma dessas fotografias e o texto aprovado da minha resposta sejam enviados à Google (Veo) para gerar um vídeo por IA em que apareço a dizer esse texto em inglês, com gestos e uma voz gerados pelo modelo (não é a minha voz), sempre com o aviso visível «AI-generated video · AI voice».', photoAuth: 'Autorizações das fotografias',
    openCamera: 'Abrir câmara', take: 'Tirar fotografia', keep: 'Guardar esta', discard: 'Descartar', skipPhotos: 'Terminar sem fotografias', photoUpload: 'Carregar fotografia', photosDone: 'Concluir fotografias',
    camDenied: 'A câmara não está disponível. Pode carregar uma fotografia.', max3: 'Máximo de três fotografias.',
    review: 'Rever e submeter', yourAnswers: 'As suas respostas', noPhotos: 'Sem fotografias', pendingUploads: 'Ainda há respostas por enviar ou por responder.',
    submit: 'Submeter entrevista', submitConfirm: 'Quer submeter? Depois de submeter, só poderá alterar contactando quem o convidou.',
    thanks: 'Obrigado!', thanksText: 'A sua entrevista foi submetida. Recebe aqui o comprovativo.', receipt: 'Comprovativo',
    contact: 'Para correções, contacte', episodePreview: 'Pré-visualização do episódio', approve: 'Aprovo esta versão', requestChanges: 'Quero pedir alterações', notePlaceholder: 'Diga o que pretende alterar',
    emailSubject: (h: string, t: string) => `${h} convida-o(a) para uma entrevista — ${t}`,
    emailLine: 'Pode responder no telemóvel, no seu ritmo, gravando as respostas em áudio.',
    emailDecline: 'Se não pretende participar, abra o link e escolha "Não pretendo participar".',
    deadline: 'Prazo', saved: 'Guardado.',
  },
  en: {
    inviteTitle: 'Invitation to an interview',
    invitedBy: (h: string) => `${h} invites you to answer an interview.`,
    qCount: (n: number) => `${n} question${n === 1 ? '' : 's'} · answer on your phone, whenever suits you`,
    open: 'Open interview', decline: 'I do not wish to take part', declined: 'We have recorded that you do not wish to take part. Thank you for letting us know.',
    expired: 'This link has expired or was revoked', expiredHelp: 'Ask the person who invited you for a new invitation, or enter your email to receive a new link.',
    resendBtn: 'Send a new link', resendDone: 'If the email matches an invitation, we have sent a new link.', yourEmail: 'Your email',
    beforeStart: 'Before you start', objective: 'Purpose of the interview',
    consentIntro: 'Choose what you allow. Nothing is pre-selected. You may refuse anything that is not needed to take part.',
    c_participation: 'Taking part and recording my answers (needed to answer).',
    c_processing: 'Transcription, translation into English and narration with AI-generated synthetic voices, using external services.',
    c_publish: 'Publication of the resulting episode, after I have seen and approved it.',
    consentLong: 'Organiser: the interviewer named in the invitation. Purposes: record your answers, transcribe and translate them, and produce an English-language podcast episode narrated with synthetic voices (we do not clone your voice). External services: transcription, translation and synthetic voice are provided by an AI vendor. Publication: only after you approve the result. Retention: the originals stay private and you can ask for deletion through the support contact.',
    adults: 'I confirm I am 18 or older.',
    save: 'Save and continue', start: 'Start', continue: 'Continue',
    question: 'Question', of: 'of', listen: 'Listen to the question', listenSynth: 'Read aloud with an AI-generated voice.', record: 'Record answer', stop: 'Stop', hear: 'Play my answer',
    redo: 'Redo', confirm: 'Confirm and continue', saveExit: 'Save and leave', refuse: 'I prefer not to answer', uploadOwn: 'Upload an existing recording',
    stLocal: 'Recorded on this device', stUp: 'Uploading…', stSaved: 'Saved on the server', stFail: 'Upload failed. You can try again.', retry: 'Try again',
    micDenied: 'Microphone access was refused. You can upload an existing recording.', micNone: 'No microphone was found.', empty: 'The recording is empty. Please try again.',
    silent: 'The recording seems silent. You can redo it or continue anyway.', tooLong: 'The recording exceeds the limit.', otherAudio: 'Stop any other audio (music, video) before recording.',
    refused: 'You chose not to answer this question.', answered: 'Answer saved',
    photos: 'Photos (optional)', photosIntro: 'You may take up to three selfies of your choice to go with the interview. We only use the ones you choose, and only for the purposes you allow.',
    c_photo: 'I allow the capture and storage of the photos I choose.', c_cover: 'I allow one or more photos to be used on the episode cover.', c_pubphoto: 'I allow those photos to be published with the episode.', c_animate: 'I allow one of those photos to be animated by AI in the episode video (mouth movement synchronised with the synthetic English voice), always with the visible notice “AI-animated portrait”.', versionChanged: 'The video changed since you opened this page: please watch the current version before approving.', c_aivideo: 'I allow one of those photos and the approved text of my answer to be sent to Google (Veo) to generate an AI video in which I appear saying that text in English, with gestures and a voice generated by the model (not my own voice), always with the visible notice “AI-generated video · AI voice”.', photoAuth: 'Photo permissions',
    openCamera: 'Open camera', take: 'Take photo', keep: 'Keep this one', discard: 'Discard', skipPhotos: 'Finish without photos', photoUpload: 'Upload a photo', photosDone: 'Finish photos',
    camDenied: 'The camera is not available. You can upload a photo instead.', max3: 'Maximum of three photos.',
    review: 'Review and submit', yourAnswers: 'Your answers', noPhotos: 'No photos', pendingUploads: 'Some answers are still missing or not uploaded.',
    submit: 'Submit interview', submitConfirm: 'Submit now? After submitting you can only change things by contacting the interviewer.',
    thanks: 'Thank you!', thanksText: 'Your interview has been submitted. Here is your receipt.', receipt: 'Receipt',
    contact: 'For corrections, contact', episodePreview: 'Episode preview', approve: 'I approve this version', requestChanges: 'I want to request changes', notePlaceholder: 'Tell us what to change',
    emailSubject: (h: string, t: string) => `${h} invites you to an interview — ${t}`,
    emailLine: 'You can answer on your phone, at your own pace, by recording your answers.',
    emailDecline: 'If you do not wish to take part, open the link and choose "I do not wish to take part".',
    deadline: 'Deadline', saved: 'Saved.',
  },
} as const;

export const t = (lang: Lang) => D[lang];

export const CONSENT_VERSION = 'v1-2026-10';
export const CONSENT_PURPOSES = ['participation', 'processing', 'photo_capture', 'cover_use', 'publish_photo', 'animate_portrait', 'ai_video', 'publish'] as const;
export type ConsentPurpose = typeof CONSENT_PURPOSES[number];
export function consentText(lang: Lang, purpose: ConsentPurpose): string {
  const d = D[lang];
  return ({ participation: d.c_participation, processing: d.c_processing, photo_capture: d.c_photo, cover_use: d.c_cover, publish_photo: d.c_pubphoto, animate_portrait: d.c_animate, ai_video: d.c_aivideo, publish: d.c_publish } as const)[purpose];
}
