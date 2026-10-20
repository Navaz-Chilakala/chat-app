import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { query, queryOne } from "../db";

export interface BlobStorage {
  driver: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class DbStorage implements BlobStorage {
  driver = "db";
  async put(key: string, data: Buffer) {
    await query("INSERT INTO document_blobs(storage_key, data) VALUES ($1,$2) ON CONFLICT (storage_key) DO NOTHING", [key, data]);
  }
  async get(key: string) {
    const row = await queryOne<{ data: Buffer }>("SELECT data FROM document_blobs WHERE storage_key = $1", [key]);
    if (!row) throw new Error(`Blob not found: ${key}`);
    return row.data;
  }
  async delete(key: string) {
    await query("DELETE FROM document_blobs WHERE storage_key = $1", [key]);
  }
}

class LocalStorage implements BlobStorage {
  driver = "local";
  constructor(private dir: string) {}
  private file(key: string) {
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    return path.join(this.dir, key);
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }
  async get(key: string) {
    return fs.readFile(this.file(key));
  }
  async delete(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
}

class S3Storage implements BlobStorage {
  driver = "s3";
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;
  constructor(private bucket: string) {
    this.clientPromise = import("@aws-sdk/client-s3").then(({ S3Client }) => {
      const e = env();
      return new S3Client({
        region: e.S3_REGION || "auto",
        endpoint: e.S3_ENDPOINT || undefined,
        forcePathStyle: !!e.S3_ENDPOINT,
        credentials: e.S3_ACCESS_KEY_ID ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } : undefined,
      });
    });
  }
  async put(key: string, data: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: env().S3_ENDPOINT ? undefined : "AES256" }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let cached: BlobStorage | null = null;
export function storage(): BlobStorage {
  if (cached) return cached;
  const e = env();
  if (e.STORAGE_DRIVER === "s3") {
    if (!e.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
    cached = new S3Storage(e.S3_BUCKET);
  } else if (e.STORAGE_DRIVER === "local") cached = new LocalStorage(path.resolve(e.STORAGE_LOCAL_DIR));
  else cached = new DbStorage();
  return cached;
}
