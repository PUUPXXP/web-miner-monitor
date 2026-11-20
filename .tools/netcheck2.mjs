import { NetworkStats } from '../server/network.js';
const n = new NetworkStats({ warn: (m) => console.log('warn:', m) });
console.log('coinlore XMR:', JSON.stringify(await n.coinloreTicker('28')));
const st = await n.refresh(true);
console.log('price:', JSON.stringify(st.price));
console.log('net.XMR height:', st.net?.XMR?.height);
