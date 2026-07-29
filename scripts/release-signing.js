'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function keyId(keyMaterial) {
  const key = keyMaterial?.type === 'public' ? keyMaterial : crypto.createPublicKey(keyMaterial);
  const der = key.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
}

function generate() {
  const privatePath = path.resolve(argument('--private') || 'release-private.pem');
  const publicPath = path.resolve(argument('--public') || 'release-public-key.pem');
  if (fs.existsSync(privatePath) || fs.existsSync(publicPath)) {
    throw new Error('Refusing to overwrite an existing release signing key');
  }
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(privatePath, 0o600);
  fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  console.log(`Generated Ed25519 release key ${keyId(publicKey)}`);
}

function sign() {
  const privatePath = path.resolve(argument('--key') || '');
  const filePath = path.resolve(argument('--file') || '');
  const outputPath = path.resolve(argument('--output') || `${filePath}.sig`);
  if (!fs.statSync(privatePath).isFile() || !fs.statSync(filePath).isFile()) throw new Error('Signing key or input file is missing');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must be Ed25519');
  const publicKey = crypto.createPublicKey(privateKey);
  const signature = crypto.sign(null, fs.readFileSync(filePath), privateKey);
  const envelope = {
    version: 1,
    algorithm: 'Ed25519',
    keyId: keyId(publicKey),
    file: path.basename(filePath),
    signature: signature.toString('base64')
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
  console.log(`Signed ${path.basename(filePath)} with key ${envelope.keyId}`);
}

function verify() {
  const publicPath = path.resolve(argument('--public') || '');
  const filePath = path.resolve(argument('--file') || '');
  const signaturePath = path.resolve(argument('--signature') || `${filePath}.sig`);
  const publicKey = crypto.createPublicKey(fs.readFileSync(publicPath));
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Release public key must be Ed25519');
  const envelope = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
  if (envelope.version !== 1 || envelope.algorithm !== 'Ed25519' || envelope.file !== path.basename(filePath) || envelope.keyId !== keyId(publicKey)) {
    throw new Error('Release signature metadata is invalid');
  }
  const signature = Buffer.from(String(envelope.signature || ''), 'base64');
  if (signature.length !== 64 || !crypto.verify(null, fs.readFileSync(filePath), publicKey, signature)) {
    throw new Error('Release signature verification failed');
  }
  console.log(`Verified ${path.basename(filePath)} with key ${envelope.keyId}`);
}

try {
  if (process.argv.includes('--generate')) generate();
  else if (process.argv.includes('--sign')) sign();
  else if (process.argv.includes('--verify')) verify();
  else throw new Error('Use --generate, --sign, or --verify');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
