import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

let client: S3Client | undefined;

function getClient(): S3Client {
  if (client) return client;

  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 storage is not configured — set S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY");
  }

  client = new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey } });
  return client;
}

/** Downloads a (often short-lived) provider video URL and re-uploads it to our own bucket, returning our durable URL. */
export async function uploadVideoFromUrl(sourceUrl: string, key: string): Promise<string> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error("S3_BUCKET is not configured");
  }

  const response = await fetch(sourceUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download generated video from provider: HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: response.headers.get("content-type") ?? "video/mp4",
    })
  );

  const endpoint = process.env.S3_ENDPOINT!.replace(/\/$/, "");
  return `${endpoint}/${bucket}/${key}`;
}
