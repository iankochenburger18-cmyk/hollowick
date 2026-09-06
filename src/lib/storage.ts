import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// SigV4 presigned URLs cap out at 7 days — there's no "durable" URL for a
// private bucket without either making objects public or re-signing on
// access, so resultUrl will need re-signing past this window.
const RESULT_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

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
  const client = getClient();

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: response.headers.get("content-type") ?? "video/mp4",
    })
  );

  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: RESULT_URL_EXPIRY_SECONDS,
  });
}
