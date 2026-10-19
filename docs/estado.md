# Estado (2026-10-19)

## Implementado e testado (testes automáticos, IA em modo simulado, FFmpeg e sharp reais)
Landing EN; contas; criação/edição de entrevistas com perguntas (texto/áudio), foto, objetivo (texto/áudio); convite por outbox deduplicada; token só em hash, GET não consome, sessão por cookie HttpOnly; consentimentos separados e versionados; gravação por MediaRecorder + upload com idempotência e validação real (sniff + ffprobe/decodificação); recusa explícita; selfies com remoção de EXIF; submissão idempotente com snapshot e email único; pipeline (transcrição → guião → revisão → aprovação → voz → montagem loudnorm → cues medidos → capa → QC); aprovações invalidadas por alterações; publicação privada/não listada/pública; retirada; leitor com legendas sincronizadas por currentTime; VTT/SRT; CSRF; isolamento entre utilizadores; limites de ritmo.

## NÃO verificado
- Chamadas reais à OpenAI (nomes de modelos e parâmetros por confirmar na documentação vigente), MailerSend e S3.
- Safari/iOS e Android em dispositivos físicos (formatos de MediaRecorder, interrupções, bloqueio de ecrã). Só validado o código de deteção de formato.
- Renderização do texto da capa com as fontes do servidor Render (sharp/librsvg usa as fontes do sistema).
## Por fazer
Upload em chunks retomável e checkpoint em IndexedDB; MFA de administradores; gestão de utilizadores/convites de entrevistadores; políticas de retenção e apagamento automatizadas; RSS; exportação MP4; mais línguas com resegmentação; testes Playwright; lista de subcontratantes e base legal por finalidade (documentos legais).
Custos mostrados são estimativas (preços configuráveis por variáveis PRICE_*).
