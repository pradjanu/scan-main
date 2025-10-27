#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import pLimit from 'p-limit';
import { format as csvFormat } from 'fast-csv';

const INFILE = process.env.FIDS_FILE || 'fids.txt';
const OUTDIR = process.env.OUT_DIR || 'out';
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const BASE = process.env.BASE || 'https://www.harmonybot.xyz';
const ADDR = process.env.WALLET_ADDRESS || process.env.ADDR || '';
const RARE_ONLY = String(process.env.RARE_ONLY || '0') === '1';
const TOP_K = parseInt(process.env.TOP_K || '10', 10);
const MIN_SCORE = parseFloat(process.env.MIN_SCORE || '0');

if (!fs.existsSync(INFILE)) {
  console.error(`Missing ${INFILE} (isi: satu FID per baris)`);
  process.exit(1);
}
fs.mkdirSync(OUTDIR, { recursive: true });

const fids = fs.readFileSync(INFILE, 'utf8')
  .split(/\r?\n/).map(s => s.trim()).filter(Boolean);

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function jitter(ms){ return Math.round(ms * (0.8 + Math.random()*0.4)); }

async function httpPost(url, body={}, {timeout=15000}={}) {
  return axios.post(url, body, { timeout });
}

function maybeSavePng(data, fid){
  const b64 = data?.generatedImage || data?.imageBase64 || null;
  if (!b64) return null;
  try {
    const bin = Buffer.from(b64, 'base64');
    const out = path.join(OUTDIR, `warplet-${fid}.png`);
    fs.writeFileSync(out, bin);
    return out;
  } catch { return null; }
}

/** Normalize traits to [{trait_type, value, percent?, rarity?}] */
function normalizeTraits(data){
  // Common shapes:
  // - data.attributes: [{trait_type, value, percent or rarity or frequency}]
  // - data.traits:     same idea
  const raw = Array.isArray(data?.attributes) ? data.attributes :
              Array.isArray(data?.traits) ? data.traits : [];
  return raw.map(t => {
    const percent = t.percent ?? t.percentage ?? t.frequency ?? t.rarityPercent ?? null;
    const rarity = t.rarity ?? t.score ?? null;
    return {
      trait_type: t.trait_type ?? t.traitType ?? t.type ?? 'trait',
      value: t.value ?? t.name ?? t.val ?? '',
      percent: typeof percent === 'string' && percent.endsWith('%')
        ? parseFloat(percent) : (typeof percent === 'number' ? percent : null),
      rarity
    };
  });
}

/** Rarity scoring:
 * 1) use data.rarityScore if present
 * 2) else: sum(-log(p)) where p = percent/100; if no percent, +0.5 as tiny weight
 */
function rarityScore(data){
  if (typeof data?.rarityScore === 'number') return data.rarityScore;
  const traits = normalizeTraits(data);
  let score = 0;
  for (const t of traits){
    if (typeof t.percent === 'number' && t.percent > 0){
      const p = t.percent / 100;
      score += -Math.log(p); // natural log, lebih besar = lebih langka
    } else if (typeof t.rarity === 'number') {
      score += t.rarity;
    } else {
      score += 0.5; // sedikit bobot kalau tak ada info
    }
  }
  return Number(score.toFixed(6));
}

function traitsSummary(data){
  const traits = normalizeTraits(data);
  return traits.map(t => {
    const pct = (t.percent != null) ? `${t.percent}%` : '';
    return `${t.trait_type}:${t.value}${pct ? `(${pct})` : ''}`;
  }).join(' | ');
}

/** GENERATE loop: keep retrying w/ capped backoff */
async function generateMeta(fid){
  let backoff = 10; // ms
  const maxBack = 50;
  for(;;){
    try{
      const { data, status } = await httpPost(`${BASE}/api/warplet/${fid}`, {});
      if (status === 200 && data){
        const jsonPath = path.join(OUTDIR, `warplet-${fid}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
        const pngPath = maybeSavePng(data, fid);
        return { ok:true, data, jsonPath, pngPath };
      }
      console.log(`ℹ️  ${fid} -> HTTP ${status}`);
    }catch(e){
      const code = e.response?.status || e.code || e.message;
      console.log(`⚠️  ${fid} -> ${code}`);
    }
    backoff = Math.min(maxBack, Math.max(500, Math.floor(backoff * 1.5)));
    await sleep(jitter(backoff));
  }
}

/** SIGN: request signature for mint */
async function requestSignature(fid, wallet){
  let backoff = 10;
  const maxBack = 50;
  for(;;){
    try{
      const url = `${BASE}/api/warplet/generateSignature/${fid}`;
      const { data, status } = await httpPost(url, { walletAddress: wallet });
      if (status === 200 && data){
        const out = path.join(OUTDIR, `sign-${fid}.json`);
        fs.writeFileSync(out, JSON.stringify(data, null, 2));
        return { ok:true, data, path: out };
      }
      console.log(`ℹ️  sign ${fid} -> HTTP ${status}`);
    }catch(e){
      const code = e.response?.status || e.code || e.message;
      console.log(`⚠️  sign ${fid} -> ${code}`);
    }
    backoff = Math.min(maxBack, Math.max(800, Math.floor(backoff * 1.5)));
    await sleep(jitter(backoff));
  }
}

/** MAIN */
const limit = pLimit(CONCURRENCY);

// 1) Generate all first (biar kita bisa ranking)
console.log(`== Generate ${fids.length} FIDs (concurrency=${CONCURRENCY}) ==`);
const metas = await Promise.all(fids.map(fid => limit(async () => {
  const res = await generateMeta(fid);
  const score = rarityScore(res.data);
  const summary = traitsSummary(res.data);
  return {
    fid, score, summary,
    jsonPath: res.jsonPath,
    pngPath: res.pngPath || '',
    data: res.data
  };
})));

metas.sort((a,b)=> b.score - a.score);

// 2) Tulis index.csv
const csvPath = path.join(OUTDIR, 'index.csv');
await new Promise(resolve => {
  const stream = csvFormat({ headers: true });
  const ws = fs.createWriteStream(csvPath);
  stream.pipe(ws).on('finish', resolve);
  for (const m of metas){
    stream.write({
      fid: m.fid,
      rarityScore: m.score,
      traits: m.summary,
      json: path.basename(m.jsonPath),
      png: m.pngPath ? path.basename(m.pngPath) : '',
      signature: '',      // diisi setelah langkah 3
      sig_error: ''
    });
  }
  stream.end();
});
console.log(`📄  Wrote ${csvPath}`);
console.log('🏆 Top 10 by score:');
metas.slice(0, 10).forEach((m,i)=>console.log(`#${i+1} FID=${m.fid} score=${m.score} :: ${m.summary}`));

// 3) Request signature
let targets;
if (!ADDR){
  console.log('⚠️  WALLET_ADDRESS kosong → skip signature step. (Set WALLET_ADDRESS=0x...)');
  targets = [];
} else if (RARE_ONLY){
  targets = metas.filter(m => m.score >= MIN_SCORE)
                 .slice(0, TOP_K);
  console.log(`🔎 RARE_ONLY=1 → request signature untuk ${targets.length} kandidat (TOP_K=${TOP_K}, MIN_SCORE=${MIN_SCORE})`);
} else {
  targets = metas;
  console.log(`🖊️  Request signature untuk semua (${targets.length})`);
}

const sigResults = await Promise.all(targets.map(m => limit(async () => {
  const r = await requestSignature(m.fid, ADDR);
  return { fid: m.fid, ok: r.ok, path: r.path || '', error: r.ok ? '' : (r.error || 'unknown') };
})));

// 4) Update index.csv (signature info)
const sigMap = new Map(sigResults.map(s => [s.fid, s]));
const rows = metas.map(m => ({
  fid: m.fid,
  rarityScore: m.score,
  traits: m.summary,
  json: path.basename(m.jsonPath),
  png: m.pngPath ? path.basename(m.pngPath) : '',
  signature: sigMap.get(m.fid)?.ok ? path.basename(sigMap.get(m.fid)?.path) : '',
  sig_error: sigMap.get(m.fid)?.error || (ADDR ? '' : 'NO_WALLET')
}));
await new Promise(resolve => {
  const stream = csvFormat({ headers: true });
  const ws = fs.createWriteStream(csvPath);
  stream.pipe(ws).on('finish', resolve);
  for (const r of rows) stream.write(r);
  stream.end();
});
console.log(`✅  Updated ${csvPath} with signature results.`);

console.log('\nTips: untuk hanya mint kandidat rare, jalankan dengan:');
console.log('  RARE_ONLY=1 TOP_K=5 WALLET_ADDRESS=0x... node warplet.js');
