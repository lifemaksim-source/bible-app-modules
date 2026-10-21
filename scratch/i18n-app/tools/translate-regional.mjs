/**
 * Generate full machine-draft Bible App UI translations (no API key required).
 * Existing i18next remains the sole runtime system.
 *
 * node tools/translate-regional.mjs --languages=tg,mn,kk,uz,ky,tt,ba,sah
 * node tools/translate-regional.mjs --sync-only
 *
 * Machine translation needs later native-speaker review before public release.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const localDir = 'src/i18n/locales';
const bookDir = 'src/i18n/books';
const source = JSON.parse(readFileSync(join(localDir, 'ru.json'), 'utf8'));
const bookSource = JSON.parse(readFileSync(join(bookDir, 'ru.json'), 'utf8'));
const existing = new Set(['ru','en','de','fr','es','pt','pl','uk','ja','az']);
const names = {
  ady:'Адыгабзэ', av:'МагӀарул мацӀ', ba:'Башҡортса',
  be:'Беларуская', bg:'Български', bua:'Буряад хэлэн',
  ce:'Нохчийн мотт', crh:'Qırımtatar tili', cs:'Čeština',
  cv:'Чӑвашла', dar:'Дарган мез', dng:'Хуэйзў йүян',
  et:'Eesti', gag:'Gagauzça', hr:'Hrvatski', hu:'Magyar',
  hy:'Հայերեն', inh:'ГӀалгӀай мотт', ka:'ქართული',
  kaa:'Qaraqalpaq tili', kbd:'Адыгэбзэ', kk:'Қазақша',
  kom:'Коми кыв', ky:'Кыргызча', lbe:'Лакку маз',
  lez:'Лезги чӏал', lt:'Lietuvių', lv:'Latviešu',
  mk:'Македонски', mn:'Монгол', nog:'Ногай тили',
  os:'Ирон æвзаг', ro:'Română', sah:'Саха тыла',
  sk:'Slovenčina', sl:'Slovenščina', sq:'Shqip',
  sr:'Српски', tab:'Табасаран чӏал', tg:'Тоҷикӣ',
  tk:'Türkmençe', tt:'Татарча', tyv:'Тыва дыл',
  udm:'Удмурт кыл', uz:'Oʻzbekcha',
};
const separator = '[[[SEP]]]';
const safeFallbacks = [];
const placeholders = (s) => [...s.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]).sort().join('|');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function remote(code, text) {
  const params = new URLSearchParams({ client:'gtx', sl:'ru', tl:code, dt:'t', q:text });
  let reason = '';
  for (let n = 0; n < 3; n++) {
    try {
      const response = await fetch('https://translate.googleapis.com/translate_a/single?' + params, {
        signal: AbortSignal.timeout(22000),
      });
      if (!response.ok) {
        if (response.status === 400) throw Error('language unsupported');
        throw Error('HTTP '+response.status);
      }
      const json = await response.json();
      const translated = (json?.[0] || []).map((part) => part[0] || '').join('');
      if (!translated.trim()) throw Error('empty translation response');
      return translated;
    } catch (error) {
      reason = String(error.message);
      if (reason.includes('unsupported')) break;
      await delay(900*(n+1));
    }
  }
  throw Error(code + ': ' + reason);
}
function encodeVariables(s) {
  const vars = [];
  const masked = s.replace(/\{\{([^}]+)\}\}/g, (_,v) => {
    vars.push(v);
    return 'ZZZVARIABLE'+(vars.length-1)+'ZZZ';
  });
  return {masked,vars};
}
function decodeVariables(s,vars) {
  let out = s.trim();
  vars.forEach((v,i) => { out=out.replaceAll('ZZZVARIABLE'+i+'ZZZ','{{'+v+'}}'); });
  return out.trim();
}
/** Last-resort translation of individual text spans around protected variables. */
async function translateAroundVariables(code, original) {
  const pieces = original.split(/(\{\{[^}]+\}\})/g);
  const output = [];
  for(const piece of pieces) {
    if(!piece || /^\{\{[^}]+\}\}$/.test(piece) || !piece.trim()) {
      output.push(piece);
      continue;
    }
    const match = piece.match(/^(\s*)([\s\S]*?)(\s*)$/);
    output.push(match[1] + (await remote(code, match[2])).trim() + match[3]);
  }
  return output.join('');
}
async function translateAll(code, items) {
  const output = Array(items.length);
  const batchSize = 9;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const start = cursor;
      cursor += batchSize;
      const selected = items.slice(start,start+batchSize);
      const encoded = selected.map(encodeVariables);
      const batch = encoded.map((e)=>e.masked).join('\n'+separator+'\n');
      let results = (await remote(code,batch)).split(separator);
      if (results.length !== selected.length) {
        results = [];
        for(const p of encoded) results.push(await remote(code,p.masked));
      }
      for(let i=0;i<selected.length;i++) {
        let value = decodeVariables(results[i]||'',encoded[i].vars);
        if (!value || placeholders(value)!==placeholders(selected[i])) {
          value = decodeVariables(await remote(code,encoded[i].masked),encoded[i].vars);
        }
        if (!value || placeholders(value)!==placeholders(selected[i])) {
          // Translate natural-language fragments around source variables.
          // Never send the {{value}} keys themselves to machine translation.
          try {
            value = await translateAroundVariables(code, selected[i]);
            if (!value || placeholders(value)!==placeholders(selected[i])) throw Error('bad segmented result');
            safeFallbacks.push({code,index:start+i,method:'segmented'});
          } catch (error) {
            value = selected[i];
            safeFallbacks.push({code,index:start+i,method:'source-fallback'});
          }
        }
        output[start+i]=value;
      }
    }
  };
  await Promise.all(Array.from({length:6},()=>worker()));
  if(output.some((s)=>!s))throw Error(code+': incomplete');
  return output;
}
function compileResources() {
  const ready = readdirSync(localDir)
    .filter((f)=>/^[a-z]{2,3}\.json$/.test(f))
    .map((f)=>f.slice(0,-5))
    .filter((code)=>!existing.has(code)&&names[code]&&existsSync(join(bookDir,code+'.json')))
    .sort();
  const rows = ['// AUTO-GENERATED: enable only locales with complete UI + 78 book names.'];
  for (const code of ready) {
    rows.push("import locale_"+code+" from './locales/"+code+".json';");
    rows.push("import books_"+code+" from './books/"+code+".json';");
  }
  rows.push('','export const EXTRA_LANGUAGE_NAMES = {');
  for(const code of ready)rows.push('  '+code+': '+JSON.stringify(names[code])+',');
  rows.push('} as const;','','export const EXTRA_RESOURCES = {');
  for(const code of ready)rows.push('  '+code+': { translation: locale_'+code+' },');
  rows.push('};','','export const EXTRA_BOOKS = {');
  for(const code of ready)rows.push('  '+code+': books_'+code+',');
  rows.push('};','');
  writeFileSync('src/i18n/extraLocalizations.ts',rows.join('\n'),'utf8');
  return ready;
}
async function main(){
  if(process.argv.includes('--sync-only')){
    console.log('Enabled: '+compileResources().join(', '));return;
  }
  const codes=(process.argv.find((a)=>a.startsWith('--languages='))||'')
    .slice('--languages='.length).split(',').filter(Boolean);
  if(!codes.length || codes.some((c)=>!names[c]||existing.has(c))) throw Error('Provide valid --languages=tg,mn,...');
  const keys=Object.keys(source), bk=Object.keys(bookSource);
  const report=[];
  for(const code of codes){
    if(existsSync(join(localDir,code+'.json'))&&existsSync(join(bookDir,code+'.json'))){
      report.push({code,status:'existing'});continue;
    }
    console.log('Generating '+code+': '+keys.length+' interface keys and '+bk.length+' book names');
    try {
      const labels=await translateAll(code,keys.map((k)=>source[k]));
      const bookLabels=await translateAll(code,bk.map((k)=>bookSource[k].name));
      const locale=Object.fromEntries(keys.map((k,i)=>[k,labels[i]]));
      const books=Object.fromEntries(bk.map((k,i)=>[k,{
        name:bookLabels[i],abbr:bookLabels[i].slice(0,6),
      }]));
      if(keys.some((key)=>placeholders(source[key])!==placeholders(locale[key])) ||
         bk.some((key)=>!books[key].name))throw Error('bad source alignment');
      writeFileSync(join(localDir,code+'.json'),JSON.stringify(locale,null,2)+'\n');
      writeFileSync(join(bookDir,code+'.json'),JSON.stringify(books,null,2)+'\n');
      report.push({code,status:'machine-draft',uiKeys:keys.length,bookKeys:bk.length,
        safeRussianFallbacks: safeFallbacks.filter((x)=>x.code===code)});
      console.log(code+' generated');
    }catch(e){
      report.push({code,status:'failed',reason:String(e.message).slice(0,200)});
      console.log(code+' not generated: '+e.message);
    }
  }
  const enabled=compileResources();
  const result={report,enabled,sourceKeys:keys.length,machineTranslated:true,humanReviewed:false};
  writeFileSync('regional-translation-report.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  if(!report.some((r)=>r.status==='machine-draft'||r.status==='existing')){
    throw Error('No completed locales; do not claim availability');
  }
}
await main();
