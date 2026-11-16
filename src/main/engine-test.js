// Teste do engine sem Electron: node src/main/engine-test.js <baseURL> <modelo> "<pedido>" [apiKey]
const { Module } = require('module');
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'electron' ? { app: { getPath: () => process.cwd() } } : orig.call(this, r, ...a); };
const { DEFAULTS } = require('./settings');
const { Engine } = require('./engine');
const [baseURL, model, ask, apiKey] = process.argv.slice(2);
const cfg = { ...DEFAULTS, workDir: process.cwd(), providers: [{ id: 'p', baseURL, apiKey }], defaultModel: `p/${model}`,
  permissions: { read: 'allow', write: 'allow', exec: 'allow', net: 'allow' } };
const e = new Engine(() => cfg, (ev) => {
  if (ev.type === 'text') process.stdout.write(ev.text);
  else if (ev.type !== 'reasoning' && ev.type !== 'usage') console.log('\n#', ev.type, ev.agent || ev.name || '', ev.status || '', JSON.stringify(ev.args || '').slice(0, 100));
}, async () => 'once');
e.send(ask, []).then(() => console.log('\nfim'));
