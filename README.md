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

## Estado e limites conhecidos
Ver `docs/estado.md` (o que foi testado com mocks, o que exige dispositivos reais e o que ainda falta).
