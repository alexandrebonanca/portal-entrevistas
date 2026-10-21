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

Notas: a chave é validada ao guardar, fica cifrada e nunca volta ao ecrã (aparecem só o email da conta e o projeto). Nas entidades, as credenciais do Veo valem em conjunto: se a entidade tiver conta de serviço ou chave Gemini próprias, o Veo dela usa só essas (e paga no projeto Google dela); as globais servem só às entidades sem credenciais Google. Com conta de serviço, o Veo usa sempre o Vertex AI; a chave da Gemini API fica como reserva enquanto a Google a mantiver, e as operações já pagas na Gemini API continuam a ser concluídas com ela. A ficha do Lite contradiz-se sobre a imagem inicial: se o Vertex a recusar, a geração pára com uma mensagem clara (nada é cobrado) e basta escolher o Fast. Se a organização bloquear a criação de chaves (política `iam.disableServiceAccountKeyCreation`), o administrador da organização tem de a levantar para este projeto.

## Pagamentos e faturação
Quem vende ao cliente final é a **Telecert** (Stripe, IVA português, faturas no Moloni e Livro de Reclamações dela); a **Certif Int Association OÜ** é a entidade gestora da plataforma e não vende. Passos do dono:

1. **Definições → Empresa vendedora**: denominação social completa, NIF, morada da sede, email de contacto e ligação do Livro de Reclamações Eletrónico (e a entidade RAL, se houver). Enquanto faltarem a denominação, o NIF e a morada, os pagamentos em linha ficam suspensos; sem o email e o Livro de Reclamações, só as empresas podem pagar. O OSS só se liga quando as vendas a consumidores de outros países da UE, somando todas as atividades da Telecert, passarem 10 000 €/ano.
2. **Definições → Stripe**: as chaves da conta Stripe da **Telecert** e o segredo do webhook; **Guardar e testar** lê o nome da conta e avisa se não for o da empresa vendedora. Registar o webhook em `/webhooks/stripe` com os eventos indicados na página. As taxas de IVA (23%, 22%, 16%) criam-se sozinhas na primeira venda.
3. **Admin → Faturação**: cada pagamento aparece «por faturar» com o cliente, o IVA, a menção e o prazo (5.º dia útil). Emitir a fatura-recibo no Moloni da Telecert e escrever o n.º. Os pedidos de livre resolução dos consumidores aparecem na mesma página (reembolso no painel da Stripe e nota de crédito no Moloni).
4. **Créditos** (1 crédito = 1 € sem IVA; vale de finalidade única): os clientes carregam em **Créditos** (`/conta/creditos`), de 25 a 1000 créditos, só por cartão. Cada carregamento entra «por faturar» (fatura-recibo com a descrição pronta); os créditos valem 24 meses (aviso por email 30 dias antes, no trabalho periódico do worker) e gastam-se pela ordem de validade. Pagam a entrevista extra quando a quota do plano acaba (6 créditos) e as regenerações para além das 3 incluídas (1 crédito, devolvido se o trabalho falhar). **Admin → Créditos**: carteiras, carregamentos, alertas e o botão «Reembolsar saldo disponível» (nos 14 dias seguintes ao carregamento, ou depois disso só por encerramento do serviço), que pede o reembolso à Stripe e põe a nota de crédito «por faturar». Reembolsos feitos no painel da Stripe e disputas são detetados pelo pagamento e debitam a carteira (o que faltar fica em dívida e a carteira congela). Um utilizador com saldo, cativo ou dívida não muda de entidade. Ativar no webhook da Stripe os eventos novos que a página das Definições lista.

## Estado e limites conhecidos
Ver `docs/estado.md` (o que foi testado com mocks, o que exige dispositivos reais e o que ainda falta).
