import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = process.env.STRESS_HARNESS_ROOT || path.join(os.tmpdir(), 'facade-148-stress');
const lock = process.env.STRESS_HARNESS_LOCK || path.join(root, 'perf.lock');
const run = process.argv[2];
if (!/^a68-003-e1\\verified\\muse-keys-a00[2-4]$/u.test(run)) {
    throw new Error('Expected an owned Muse E1 evidence directory');
}
const out = path.join(root, 'evidence', run);
const release = path.join(out, 'working-probe-complete');
const limit = Date.now() + 150_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function read(file) {
    try { return fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function ownedLock() {
    return read(lock).split(' ').includes('run=' + run);
}
async function until(check) {
    while (Date.now() < limit) {
        const value = await check();
        if (value) return value;
        await sleep(150);
    }
    throw new Error('The isolated Muse working probe reached its deadline');
}

const observed = await until(() => {
    if (!ownedLock()) return null;
    const observedHome = /^\s+home (D:\\tmp\\d24-148\\homes\\stress-muse-busy--[0-9]+\\home)\s*$/mu.exec(
        read(path.join(out, 'storm.log')),
    )?.[1];
    if (!observedHome) return null;
    const log = read(path.join(observedHome, 'framework', 'logs', 'daemon.log'));
    const pipe = /listening on (\\\\\.\\pipe\\facade-framework-daemon-[a-f0-9]+)/u.exec(log)?.[1];
    const agent = /#a1 started #(a[0-9]+),/u.exec(log)?.[1];
    return pipe && agent ? {home: observedHome, pipe, agent} : null;
});

let socket;
try {
    socket = net.createConnection(observed.pipe);
    let chunks = '';
    let id = 0;
    const pending = new Map();
    socket.on('data', bytes => {
        chunks += bytes.toString('utf8');
        for (let newline; (newline = chunks.indexOf('\n')) >= 0;) {
            const line = JSON.parse(chunks.slice(0, newline));
            chunks = chunks.slice(newline + 1);
            pending.get(line.id)?.(line);
        }
    });
    socket.on('error', error => console.error(error.message));
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    function rpc(method, params) {
        return new Promise((resolve, reject) => {
            const request = ++id;
            const timer = setTimeout(() => {
                pending.delete(request);
                reject(new Error(method + ' received no reply'));
            }, 5_000);
            pending.set(request, reply => {
                pending.delete(request);
                clearTimeout(timer);
                if (reply.error) reject(new Error(JSON.stringify(reply.error)));
                else resolve(reply.result);
            });
            socket.write(JSON.stringify({jsonrpc:'2.0', id:request, method, params}) + '\n');
        });
    }
    const call = (op, args) => rpc('call', {op, args});
    const hello = await rpc('hello', {api_versions:[1], build:'storm', kind:'terminal'});
    if (hello.api_version !== 1 || !ownedLock()) throw new Error('The isolated daemon did not confirm the expected lease');
    const inspect = await call('agent.inspect', {target: observed.agent});
    const target = inspect?.agent?.reference;
    if (target?.agent_id !== observed.agent) throw new Error('The isolated Muse recipient is missing');
    const sessions = path.join(path.dirname(observed.home), 'user', '.local', 'share', 'muse', 'sessions');
    const native = await until(() => {
        if (!fs.existsSync(sessions)) return null;
        const entries = fs.readdirSync(sessions, {recursive: true, withFileTypes: true});
        const logs = entries.filter(entry => entry.isFile() && entry.name === 'session.jsonl');
        if (logs.length > 1) throw new Error('More than one native session under the isolated Muse profile');
        return logs.length ? path.join(logs[0].parentPath, logs[0].name) : null;
    });
    async function capture() {
        const [{agent, input}, screen] = await Promise.all([
            call('agent.inspect', {target}), call('agent.screen', {target, lines:60}),
        ]);
        const lines = screen.text.split(/\r?\n/u).filter(line => line.trim()).slice(-8);
        const records = read(native).split('\n');
        records.pop(); // Do not use an entry until its final line break is written.
        const turns = records.filter(line => line && JSON.parse(line).payload_type === 'runtime.user_intent.accepted').length;
        return {at:new Date().toISOString(), turns, state:agent.state, input:input.state,
            queue:lines.find(line => line.trimStart().startsWith('◆ Queued input')) ?? null,
            shows_work:lines.some(line => line.includes('esc to interrupt)')),
            blank_prompt:lines.some(line => line.trim() === '❯'), screen:lines.join('\n')};
    }
    const ready = sample => sample.state === 'working' && sample.shows_work && !sample.queue && sample.turns === 1 &&
        (sample.input === 'usable' || (sample.input === 'unknown' && sample.blank_prompt));
    const presses = [];
    for (let n = 0; n < 50; n++) {
        const before = n === 0 ? await until(async () => {
            const sample = await capture();
            return ready(sample) ? sample : null;
        }) : await capture();
        if (!ready(before) || !ownedLock() || Date.now() >= limit) break;
        const began = process.hrtime.bigint();
        await call('agent.type', {target, input:{kind:'raw', raw:'DQ=='}});
        await sleep(900);
        const after = await capture();
        const effect = after.turns !== before.turns || after.input === 'draft' || after.input === 'interaction' ||
            after.queue !== before.queue || !after.shows_work || after.state !== 'working';
        presses.push({before, after, effect, elapsed_ms:Number(process.hrtime.bigint() - began) / 1e6});
        fs.writeFileSync(path.join(out, 'keys.json'), JSON.stringify([{
            state:'working', key:'enter', pressed:presses.length,
            effects:presses.filter(sample => sample.effect).length, presses, fixture:'loopback held stream',
        }], null, 2) + '\n');
        if (effect) break;
    }
    console.log('Muse working empty Enter:', presses.length, 'presses', presses.filter(sample => sample.effect).length, 'effects');
} finally {
    socket?.destroy();
    if (ownedLock()) fs.writeFileSync(release, 'working probe complete\n');
}
