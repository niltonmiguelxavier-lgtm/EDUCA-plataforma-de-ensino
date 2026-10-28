import { createDecipheriv, createCipheriv, hkdfSync, randomBytes } from "node:crypto";

function identityEncryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET is required to protect teacher identity numbers.");
  }
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.from("educa", "utf8"),
      Buffer.from("teacher-identity-number-v1", "utf8"),
      32,
    ),
  );
}

export function encryptIdentityNumber(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", identityEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value.trim(), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptIdentityNumber(value: string): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = value.split(":");
  if (
    version !== "v1" ||
    !ivEncoded ||
    !tagEncoded ||
    !ciphertextEncoded
  ) {
    throw new Error("Unsupported encrypted identity number format.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    identityEncryptionKey(),
    Buffer.from(ivEncoded, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
