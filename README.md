# Portal de entrevistas (podcasts assíncronos)

Portal para convidar uma pessoa relevante a responder, no telemóvel, a uma lista de perguntas; as respostas são transcritas, adaptadas fielmente para inglês, narradas com vozes sintéticas e publicadas como episódio com legendas escolhidas pelo ouvinte. Nada é publicado sem aprovações humanas. Landing page em inglês em `/`; interface do entrevistador em português; interface do convidado em pt-PT ou inglês.

## Arranque local
```
npm install
cp .env.example .env   # opcional
AI_MOCK=1 npm start    # PGlite local + modo simulado de IA (sem custos)
npm test
```
Primeira conta criada em `/registar` = administrador; depois o registo fecha (`ALLOW_SIGNUP=true` para abrir).

## Arquitetura
Node 24 (TypeScript nativo, sem passo de compilação) · Fastify · PostgreSQL (`pg`; PGlite em desenvolvimento) · armazenamento local ou S3 · fila de trabalhos em Postgres (`FOR UPDATE SKIP LOCKED`) com worker no mesmo processo (`RUN_WORKER=0` + `npm run worker` para separar) · FFmpeg por binário (`@ffmpeg-installer`), sem shell · sharp para a capa · OpenAI SDK só no servidor.
Ver `docs/`.

## Vertex AI para o Veo
A Google desliga na Gemini API, a partir de 22/10/2026, os modelos do Veo que o portal usava. O vídeo do episódio e o Laboratório passam a usar o **Vertex AI** com uma conta de serviço: Veo 3.1 Fast (`veo-3.1-fast-generate-001`, ~0,10 $/s) ou Veo 3.1 Lite (`veo-3.1-lite-generate-001`, ~0,05 $/s, em pré-visualização), 720p com áudio, região `us-central1`. Passos do dono (uma vez):

1. Na consola da Google Cloud, escolher ou criar um **projeto com faturação ativa**.
2. Em *APIs e serviços → Biblioteca*, ativar a **Vertex AI API** nesse projeto.
3. Em *IAM e administração → Contas de serviço*, criar uma conta de serviço (ex.: `veo-portal`) e dar-lhe a função **Vertex AI User** (`roles/aiplatform.user`) no projeto.
4. Na conta de serviço, *Chaves → Adicionar chave → Criar nova chave → JSON*. O ficheiro `.json` é descarregado uma única vez.
5. No portal, **Definições → Google** (ou, para uma entidade, na página de chaves da entidade): abrir o ficheiro num editor de texto, copiar todo o conteúdo e colá-lo em «Conta de serviço do Vertex AI (JSON)»; deixar a região em branco (`us-central1`); escolher **Veo 3.1 Fast** ou **Veo 3.1 Lite**; carregar em **Guardar e testar** (confirma a conta e o acesso ao modelo sem gerar vídeo, sem custo).
6. Apagar o ficheiro do computador (ou guardá-lo num cofre de palavras-passe). **Nunca** o enviar por email ou chat, nem o guardar no repositório: quem o tiver gera vídeos à custa do projeto. Se houver suspeita de fuga, apagar a chave na consola (*Chaves*) e criar outra.

Notas: a chave é validada ao guardar, fica cifrada e nunca volta ao ecrã (aparecem só o email da conta e o projeto). Com conta de serviço, o Veo usa sempre o Vertex AI; a chave da Gemini API fica como reserva enquanto a Google a mantiver, e as operações já pagas na Gemini API continuam a ser concluídas com ela. A ficha do Lite contradiz-se sobre a imagem inicial: se o Vertex a recusar, a geração pára com uma mensagem clara (nada é cobrado) e basta escolher o Fast. Se a organização bloquear a criação de chaves (política `iam.disableServiceAccountKeyCreation`), o administrador da organização tem de a levantar para este projeto.

## Estado e limites conhecidos
Ver `docs/estado.md` (o que foi testado com mocks, o que exige dispositivos reais e o que ainda falta).
