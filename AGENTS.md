# Instruções para agentes
- Regras do produto: nunca publicar automaticamente; nunca inventar respostas/factos; sem clonagem de voz; originais nunca substituídos; chaves só no servidor; sem dados reais nas demos.
- Autorização sempre no servidor (entrevistador = dono ou admin; convidado = a sua entrevista). Ações com efeitos só por POST.
- Antes de mudar: `npm test` (Node ≥ 24). Usar `AI_MOCK=1` para testar sem custos.
- Modelos OpenAI são configuráveis por variáveis; confirmar nomes/parâmetros na documentação vigente antes de produção.
