// Who this Chrome profile is to Desk: an ECDSA P-256 key pair made once,
// its private half non-extractable, kept in this extension's IndexedDB.
// Desk remembers the public half when the person confirms the profile, and
// every later connection signs the hub's challenge with it, so a program
// that merely starts Desk Helper can't pass for this extension.

import { PROOF_PREFIX } from "./protocol";

const DB = "desk";
const STORE = "identity";
const KEY = "key";

const b64 = (bytes: ArrayBuffer): string => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
};

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const get = (db: IDBDatabase): Promise<CryptoKeyPair | undefined> =>
  new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result as CryptoKeyPair | undefined);
    req.onerror = () => reject(req.error);
  });

const put = (db: IDBDatabase, pair: CryptoKeyPair): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(pair, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

export interface Identity {
  /** The public key, raw (uncompressed point), base64. */
  publicKey: string;
  /** Four groups of four from the public key's SHA-256: what Desk's card and
   *  this extension's popup both show, so the person can match them. */
  label: string;
  sign(nonce: string): Promise<string>;
}

/** The fingerprint the person compares: `AB12-CD34-EF56-7890`. */
export const labelOf = async (raw: ArrayBuffer): Promise<string> => {
  const hex = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return [0, 4, 8, 12].map((i) => hex.slice(i, i + 4)).join("-");
};

/** This profile's identity, made the first time. */
export const identity = async (): Promise<Identity> => {
  const db = await open();
  let pair = await get(db);
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    await put(db, pair);
  }
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const privateKey = pair.privateKey;
  return {
    publicKey: b64(raw),
    label: await labelOf(raw),
    sign: async (nonce) => b64(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(PROOF_PREFIX + nonce))),
  };
};
