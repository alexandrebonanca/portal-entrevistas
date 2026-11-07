import { join } from 'node:path';
import { mkdir, stat, writeFile, rename } from 'node:fs/promises';
import { config } from './config.ts';

/**
 * Letra para as legendas em chinês gravadas na imagem: o servidor não traz letras CJK, por isso a Noto Sans SC (licença
 * SIL OFL) é descarregada uma vez, de uma versão fixa, para o disco do portal. CJK_FONT_FILE aponta para outra, se preciso.
 */
const CJK_URL = 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';
let pending: Promise<string> | null = null;
export function cjkFontFile(): Promise<string> {
  if (process.env.CJK_FONT_FILE) return Promise.resolve(process.env.CJK_FONT_FILE);
  return (pending ??= (async () => {
    const dir = join(config.storage.dir, 'fonts'), file = join(dir, 'NotoSansSC-Regular.otf');
    if ((await stat(file).catch(() => null))?.size) return file;
    await mkdir(dir, { recursive: true });
    const r = await fetch(CJK_URL, { signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw new Error(`Não foi possível obter a letra para as legendas em chinês (${r.status})`);
    const data = Buffer.from(await r.arrayBuffer());
    if (data.length < 1_000_000) throw new Error('Letra para as legendas em chinês incompleta');
    await writeFile(file + '.part', data); await rename(file + '.part', file);
    return file;
  })().catch(e => { pending = null; throw e; }));
}
