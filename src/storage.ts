import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { config } from './config.ts';

export interface Storage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Devolve stream (e intervalo opcional) para servir ficheiros com suporte a Range. */
  stream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements Storage {
  root = resolve(config.storage.dir);
  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('Chave de armazenamento inválida');
    return p;
  }
  async put(key: string, data: Buffer) { const p = this.path(key); await mkdir(dirname(p), { recursive: true }); await writeFile(p, data); }
  get(key: string) { return readFile(this.path(key)); }
  async stream(key: string, range?: { start: number; end: number }) { await stat(this.path(key)); return createReadStream(this.path(key), range); }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}

class S3Storage implements Storage {
  private client: any; private cmds: any;
  private async init() {
    if (this.client) return;
    this.cmds = await import('@aws-sdk/client-s3');
    const c = config.storage;
    this.client = new this.cmds.S3Client({
      region: c.region, endpoint: c.endpoint || undefined, forcePathStyle: !!c.endpoint,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }
  async put(key: string, data: Buffer) { await this.init(); await this.client.send(new this.cmds.PutObjectCommand({ Bucket: config.storage.bucket, Key: key, Body: data })); }
  async get(key: string) {
    await this.init();
    const r = await this.client.send(new this.cmds.GetObjectCommand({ Bucket: config.storage.bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async stream(key: string, range?: { start: number; end: number }) {
    await this.init();
    const r = await this.client.send(new this.cmds.GetObjectCommand({ Bucket: config.storage.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    return r.Body as Readable;
  }
  async remove(key: string) { await this.init(); await this.client.send(new this.cmds.DeleteObjectCommand({ Bucket: config.storage.bucket, Key: key })); }
}

export const storage: Storage = config.storage.driver === 's3' ? new S3Storage() : new LocalStorage();
