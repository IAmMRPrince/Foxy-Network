// ==============================================================================
// Foxy Network - Decentralized Domain Name System (.fox TLD) & Local TLS Authority
// Provides zero-config SSL certificates and domain resolution for:
//   - https://www.foxynetwork.fox  (and foxynetwork.fox)
//   - https://www.foxyfianance.fox (and foxyfianance.fox)
//   - https://www.foxyfinance.fox  (and foxyfinance.fox)
// ==============================================================================

import crypto from 'node:crypto';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');
const SSL_DIR = path.resolve(process.env.FOXY_STATE_DIR || path.join(ROOT_DIR, '.foxy'), 'ssl');
const CONFIG_PATH = path.resolve(ROOT_DIR, 'foxy.config.json');

export const DEFAULT_FOX_DOMAINS = {
  'www.foxynetwork.fox': {
    target: '__portal__',
    name: 'Foxy Network — Portal & Ingress Gateway',
    ssl: true,
    primaryUrl: 'https://www.foxynetwork.fox'
  },
  'foxynetwork.fox': {
    target: '__portal__',
    name: 'Foxy Network — Portal & Ingress Gateway',
    ssl: true,
    primaryUrl: 'https://www.foxynetwork.fox'
  },
  'www.foxyfianance.fox': {
    target: 'foxy-finance',
    name: 'FOXY FINANCE — Plataforma Institucional Quant & DePIN',
    ssl: true,
    primaryUrl: 'https://www.foxyfianance.fox'
  },
  'foxyfianance.fox': {
    target: 'foxy-finance',
    name: 'FOXY FINANCE — Plataforma Institucional Quant & DePIN',
    ssl: true,
    primaryUrl: 'https://www.foxyfianance.fox'
  },
  'www.foxyfinance.fox': {
    target: 'foxy-finance',
    name: 'FOXY FINANCE — Plataforma Institucional Quant & DePIN',
    ssl: true,
    primaryUrl: 'https://www.foxyfinance.fox'
  },
  'foxyfinance.fox': {
    target: 'foxy-finance',
    name: 'FOXY FINANCE — Plataforma Institucional Quant & DePIN',
    ssl: true,
    primaryUrl: 'https://www.foxyfinance.fox'
  }
};

export function loadDomainMappings() {
  const mappings = { ...DEFAULT_FOX_DOMAINS };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.gateway?.domains) {
        for (const [domain, info] of Object.entries(cfg.gateway.domains)) {
          mappings[domain.toLowerCase()] = {
            ...mappings[domain.toLowerCase()],
            ...info
          };
        }
      }
    }
  } catch {
    // Fallback to defaults
  }
  return mappings;
}

/**
 * Resolves a hostname (e.g., "www.foxyfianance.fox" or "www.foxynetwork.fox")
 * Returns { matched: boolean, target: '__portal__' | subdomain, domainInfo }
 */
export function resolveFoxDomain(hostname) {
  if (!hostname) return { matched: false, target: null };
  const cleanHost = hostname.split(':')[0].toLowerCase().trim();
  const mappings = loadDomainMappings();

  if (mappings[cleanHost]) {
    return {
      matched: true,
      hostname: cleanHost,
      target: mappings[cleanHost].target,
      domainInfo: mappings[cleanHost]
    };
  }

  // Dynamic *.fox subdomain resolution: <app>.foxynetwork.fox or <app>.fox
  if (cleanHost.endsWith('.foxynetwork.fox')) {
    const sub = cleanHost.replace(/\.foxynetwork\.fox$/, '');
    if (sub && sub !== 'www') {
      return {
        matched: true,
        hostname: cleanHost,
        target: sub,
        domainInfo: { target: sub, name: `${sub} (.fox DePIN App)`, ssl: true }
      };
    }
  } else if (cleanHost.endsWith('.fox')) {
    const parts = cleanHost.split('.');
    // e.g. app.fox or www.app.fox
    const base = parts[0] === 'www' ? parts[1] : parts[0];
    if (base && base !== 'foxynetwork') {
      if (base === 'foxyfianance' || base === 'foxyfinance') {
        return {
          matched: true,
          hostname: cleanHost,
          target: 'foxy-finance',
          domainInfo: DEFAULT_FOX_DOMAINS['www.foxyfianance.fox']
        };
      }
      return {
        matched: true,
        hostname: cleanHost,
        target: base,
        domainInfo: { target: base, name: `${base}.fox`, ssl: true }
      };
    }
  }

  return { matched: false, hostname: cleanHost, target: null };
}

// ------------------------------------------------------------------------------
// Pure Node.js ASN.1 DER X.509 v3 Self-Signed Certificate Generator (Fallback)
// Ensures HTTPS works on Windows/Linux/macOS even if OpenSSL CLI is not installed
// ------------------------------------------------------------------------------
function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function asn1Seq(...items) {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x30]), encodeLength(body.length), body]);
}

function asn1Set(...items) {
  const body = Buffer.concat(items);
  return Buffer.concat([Buffer.from([0x31]), encodeLength(body.length), body]);
}

function asn1Tag(tagByte, content) {
  return Buffer.concat([Buffer.from([tagByte]), encodeLength(content.length), content]);
}

function asn1Int(bufferOrNum) {
  let buf = typeof bufferOrNum === 'number' ? Buffer.from([bufferOrNum]) : bufferOrNum;
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return Buffer.concat([Buffer.from([0x02]), encodeLength(buf.length), buf]);
}

function asn1Oid(oidBytes) {
  const buf = Buffer.from(oidBytes);
  return Buffer.concat([Buffer.from([0x06]), encodeLength(buf.length), buf]);
}

function asn1Utf8(str) {
  const buf = Buffer.from(str, 'utf-8');
  return Buffer.concat([Buffer.from([0x0c]), encodeLength(buf.length), buf]);
}

function asn1UtcTime(date) {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const buf = Buffer.from(`${yy}${mm}${dd}${hh}${min}${ss}Z`, 'ascii');
  return Buffer.concat([Buffer.from([0x17]), encodeLength(buf.length), buf]);
}

function buildSelfSignedX509Pem(domains) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // OID sha256WithRSAEncryption: 1.2.840.113549.1.1.11
  const sigAlg = asn1Seq(
    asn1Oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]),
    Buffer.from([0x05, 0x00])
  );

  // Subject / Issuer CN=www.foxyfianance.fox (OID 2.5.4.3 = 55 04 03)
  const cnAttr = asn1Set(
    asn1Seq(asn1Oid([0x55, 0x04, 0x03]), asn1Utf8('www.foxyfianance.fox'))
  );
  const orgAttr = asn1Set(
    asn1Seq(asn1Oid([0x55, 0x04, 0x0a]), asn1Utf8('Foxy Network DePIN Authority'))
  );
  const nameSeq = asn1Seq(orgAttr, cnAttr);

  const now = new Date(Date.now() - 86400000);
  const exp = new Date(Date.now() + 3650 * 86400000); // 10 years
  const validity = asn1Seq(asn1UtcTime(now), asn1UtcTime(exp));

  // SubjectAltName Extension (OID 2.5.29.17 = 55 1d 11)
  const dnsTags = domains.map(d => asn1Tag(0x82, Buffer.from(d, 'ascii')));
  const sanValue = asn1Seq(...dnsTags);
  const sanExt = asn1Seq(
    asn1Oid([0x55, 0x1d, 0x11]),
    asn1Tag(0x04, sanValue)
  );
  // basicConstraints (2.5.29.19), critical, empty sequence = not a CA
  const bcExt = asn1Seq(
    asn1Oid([0x55, 0x1d, 0x13]),
    Buffer.from([0x01, 0x01, 0xff]),
    asn1Tag(0x04, asn1Seq())
  );
  const extensions = asn1Tag(0xa3, asn1Seq(bcExt, sanExt));

  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;

  const tbsCert = asn1Seq(
    asn1Tag(0xa0, asn1Int(2)), // v3
    asn1Int(serial),
    sigAlg,
    nameSeq,
    validity,
    nameSeq,
    publicKey,
    extensions
  );

  const signer = crypto.createSign('SHA256');
  signer.update(tbsCert);
  const signature = signer.sign(privateKey);

  const bitStringSig = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(signature.length + 1),
    Buffer.from([0x00]),
    signature
  ]);

  const certDer = asn1Seq(tbsCert, sigAlg, bitStringSig);
  const b64 = certDer.toString('base64').match(/.{1,64}/g).join('\n');
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;

  return { key: privateKey, cert: certPem };
}

/**
 * Ensures TLS certificates exist for *.fox domains and returns { key, cert }
 */
export function ensureFoxSslCredentials() {
  const keyPath = path.join(SSL_DIR, 'foxy-domains.key');
  const certPath = path.join(SSL_DIR, 'foxy-domains.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const key = fs.readFileSync(keyPath, 'utf-8');
      const cert = fs.readFileSync(certPath, 'utf-8');
      tls.createSecureContext({ key, cert });
      return { key, cert, keyPath, certPath };
    } catch {
      // Regenerate if unreadable or invalid ASN.1 structure
    }
  }

  fs.mkdirSync(SSL_DIR, { recursive: true, mode: 0o700 });

  const sanDomains = [
    'www.foxyfianance.fox',
    'foxyfianance.fox',
    'www.foxyfinance.fox',
    'foxyfinance.fox',
    'www.foxynetwork.fox',
    'foxynetwork.fox',
    '*.foxynetwork.fox',
    '*.fox',
    'localhost'
  ];

  // Try OpenSSL first if available, fallback to pure Node.js X.509 generator
  try {
    const extFile = path.join(SSL_DIR, 'openssl-san.cnf');
    const cnfContent = [
      '[req]',
      'default_bits = 2048',
      'prompt = no',
      'default_md = sha256',
      'distinguished_name = dn',
      'x509_extensions = v3_req',
      '[dn]',
      'C = CO',
      'O = Foxy Network DePIN Authority',
      'CN = www.foxyfianance.fox',
      '[v3_req]',
      'subjectAltName = @alt_names',
      // A server certificate only: it must never be able to sign other certificates
      'basicConstraints = critical, CA:FALSE',
      'keyUsage = critical, digitalSignature, keyEncipherment',
      'extendedKeyUsage = serverAuth',
      '[alt_names]',
      ...sanDomains.map((d, idx) => `DNS.${idx + 1} = ${d}`)
    ].join('\n');
    fs.writeFileSync(extFile, cnfContent, 'utf-8');

    execFileSync('openssl', ['req', '-x509', '-nodes', '-days', '825', '-newkey', 'rsa:2048',
      '-keyout', keyPath, '-out', certPath, '-config', extFile], { stdio: 'ignore' });
  } catch {
    // Pure Node.js fallback
    const creds = buildSelfSignedX509Pem(sanDomains);
    fs.writeFileSync(keyPath, creds.key, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(certPath, creds.cert, 'utf-8');
  }

  try { fs.chmodSync(keyPath, 0o600); } catch { /* not supported on this platform */ }

  return {
    key: fs.readFileSync(keyPath, 'utf-8'),
    cert: fs.readFileSync(certPath, 'utf-8'),
    keyPath,
    certPath
  };
}

