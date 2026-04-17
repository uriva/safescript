import { z } from "zod/v4";
import { op } from "../op.ts";

const base64urlEncodeBytes = (bytes: Uint8Array): string => {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
};

const base64urlDecodeBytes = (str: string): Uint8Array => {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  binary.split("").forEach((ch, i) => {
    bytes[i] = ch.charCodeAt(0);
  });
  return bytes;
};

export const generateEd25519KeyPair = op({
  input: z.object({}),
  output: z.object({ publicKey: z.string(), privateKey: z.string() }),
  tags: ["crypto", "random"],
  resources: { memoryBytes: 4096, runtimeMs: 50, diskBytes: 0 },
  run: async () => {
    const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const publicRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const privatePkcs8 = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    );
    return {
      publicKey: base64urlEncodeBytes(publicRaw),
      privateKey: base64urlEncodeBytes(privatePkcs8),
    };
  },
});

export const generateX25519KeyPair = op({
  input: z.object({}),
  output: z.object({ publicKey: z.string(), privateKey: z.string() }),
  tags: ["crypto", "random"],
  resources: { memoryBytes: 4096, runtimeMs: 50, diskBytes: 0 },
  run: async () => {
    const keyPair = await crypto.subtle.generateKey("X25519", true, [
      "deriveKey",
      "deriveBits",
    ]) as CryptoKeyPair;
    const publicRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const privatePkcs8 = new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    );
    return {
      publicKey: base64urlEncodeBytes(publicRaw),
      privateKey: base64urlEncodeBytes(privatePkcs8),
    };
  },
});

export const ed25519Sign = op({
  input: z.object({ data: z.string(), privateKey: z.string() }),
  output: z.object({ signature: z.string() }),
  tags: ["crypto"],
  resources: { memoryBytes: 2048, runtimeMs: 10, diskBytes: 0 },
  run: async ({ data, privateKey }) => {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      base64urlDecodeBytes(privateKey).buffer as ArrayBuffer,
      "Ed25519",
      false,
      ["sign"],
    );
    const dataBytes = new TextEncoder().encode(data);
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", key, dataBytes.buffer as ArrayBuffer),
    );
    return { signature: base64urlEncodeBytes(sig) };
  },
});

export const aesGenerateKey = op({
  input: z.object({}),
  output: z.object({ key: z.string() }),
  tags: ["crypto", "random"],
  resources: { memoryBytes: 1024, runtimeMs: 10, diskBytes: 0 },
  run: async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    ) as CryptoKey;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    return { key: base64urlEncodeBytes(raw) };
  },
});

export const aesEncrypt = op({
  input: z.object({ plaintext: z.string(), key: z.string() }),
  output: z.object({
    ciphertext: z.string(),
    iv: z.string(),
  }),
  tags: ["crypto"],
  resources: { memoryBytes: 65536, runtimeMs: 10, diskBytes: 0 },
  run: async ({ plaintext, key }) => {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      base64urlDecodeBytes(key).buffer as ArrayBuffer,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        encoded.buffer as ArrayBuffer,
      ),
    );
    return {
      ciphertext: base64urlEncodeBytes(ciphertext),
      iv: base64urlEncodeBytes(iv),
    };
  },
});

export const aesDecrypt = op({
  input: z.object({
    ciphertext: z.string(),
    iv: z.string(),
    key: z.string(),
  }),
  output: z.object({ plaintext: z.string() }),
  tags: ["crypto"],
  resources: { memoryBytes: 65536, runtimeMs: 10, diskBytes: 0 },
  run: async ({ ciphertext, iv, key }) => {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      base64urlDecodeBytes(key).buffer as ArrayBuffer,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const ivBytes = base64urlDecodeBytes(iv);
    const ciphertextBytes = base64urlDecodeBytes(ciphertext);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ivBytes.buffer as ArrayBuffer },
      cryptoKey,
      ciphertextBytes.buffer as ArrayBuffer,
    );
    return { plaintext: new TextDecoder().decode(plaintext) };
  },
});

export const x25519DeriveKey = op({
  input: z.object({
    myPrivateKey: z.string(),
    theirPublicKey: z.string(),
    salt: z.string(),
    info: z.string(),
  }),
  output: z.object({ derivedKey: z.string() }),
  tags: ["crypto"],
  resources: { memoryBytes: 4096, runtimeMs: 30, diskBytes: 0 },
  run: async ({ myPrivateKey, theirPublicKey, salt, info }) => {
    const privKey = await crypto.subtle.importKey(
      "pkcs8",
      base64urlDecodeBytes(myPrivateKey).buffer as ArrayBuffer,
      "X25519",
      false,
      ["deriveBits"],
    );
    const pubKey = await crypto.subtle.importKey(
      "raw",
      base64urlDecodeBytes(theirPublicKey).buffer as ArrayBuffer,
      "X25519",
      false,
      [],
    );
    const sharedBits = await crypto.subtle.deriveBits(
      { name: "X25519", public: pubKey },
      privKey,
      256,
    );
    const saltBytes = base64urlDecodeBytes(salt);
    const hkdfKey = await crypto.subtle.importKey(
      "raw",
      sharedBits,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const derivedCryptoKey = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: saltBytes.buffer as ArrayBuffer,
        info: new TextEncoder().encode(info),
      },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const raw = new Uint8Array(
      await crypto.subtle.exportKey("raw", derivedCryptoKey),
    );
    return { derivedKey: base64urlEncodeBytes(raw) };
  },
});
