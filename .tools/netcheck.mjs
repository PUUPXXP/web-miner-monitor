import { NetworkStats } from '../server/network.js';
const n = new NetworkStats({ warn: console.log });
const xmr = await n.gateTicker('XMR_USDT');
const prl = await n.gateTicker('PRL_USDT');
console.log('gate XMR:', JSON.stringify(xmr));
console.log('gate PRL:', JSON.stringify(prl));
const st = await n.refresh(true);
console.log('refresh price keys:', Object.keys(st.price), JSON.stringify(st.price));

