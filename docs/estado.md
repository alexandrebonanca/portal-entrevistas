# Estado (2026-10-19)

## Implementado e testado (testes automáticos, IA em modo simulado, FFmpeg e sharp reais)
Landing EN; contas; criação/edição de entrevistas com perguntas (texto/áudio), foto, objetivo (texto/áudio); convite por outbox deduplicada; token só em hash, GET não consome, sessão por cookie HttpOnly; consentimentos separados e versionados; gravação por MediaRecorder + upload com idempotência e validação real (sniff + ffprobe/decodificação); recusa explícita; selfies com remoção de EXIF; submissão idempotente com snapshot e email único; pipeline (transcrição → guião → revisão → aprovação → voz → montagem loudnorm → cues medidos → capa → QC); aprovações invalidadas por alterações; publicação privada/não listada/pública; retirada; leitor com legendas sincronizadas por currentTime; VTT/SRT; CSRF; isolamento entre utilizadores; limites de ritmo.

Suporte interno (in-mail, 2026-10-21), sem email: «Ajuda» para entrevistadores e gestores de entidade (`/ajuda`) e para o convidado na língua da entrevista (`/entrevista/ajuda`), com contador de respostas por ler na navegação; caixa de entrada do administrador (`/admin/suporte`) com filtros por estado, contexto (utilizador, perfil e entidade, ou entrevista, convidado e estado), resposta, fechar e reabrir. Limites: 5000 caracteres por mensagem, 10 mensagens por hora por remetente e 30 por IP; cada um só vê os seus pedidos; pedidos apagados com o utilizador ou a entrevista. O assistente virtual (perguntas e respostas) entra na página de ajuda na fase seguinte.

## NÃO verificado
- Chamadas reais à OpenAI (nomes de modelos e parâmetros por confirmar na documentação vigente), MailerSend e S3.
- Safari/iOS e Android em dispositivos físicos (formatos de MediaRecorder, interrupções, bloqueio de ecrã). Só validado o código de deteção de formato.
- Renderização do texto da capa com as fontes do servidor Render (sharp/librsvg usa as fontes do sistema).
- Google Veo no Vertex AI (2026-10-21): formatos tirados da documentação oficial e testados só com respostas simuladas. Por confirmar com a conta real: token da conta de serviço, resposta de «Guardar e testar» a uma operação inexistente (esperado 404), vídeo devolvido em base64 sem `storageUri`, se o Veo 3.1 Lite aceita a imagem inicial e a mensagem com que a recusa, e se o `negativePrompt` evita o texto no ecrã. Ver «Vertex AI para o Veo» no README.
## Por fazer
Upload em chunks retomável e checkpoint em IndexedDB; MFA de administradores; gestão de utilizadores/convites de entrevistadores; políticas de retenção e apagamento automatizadas; RSS; exportação MP4; mais línguas com resegmentação; testes Playwright; lista de subcontratantes e base legal por finalidade (documentos legais).
Custos mostrados são estimativas (preços configuráveis por variáveis PRICE_*).
