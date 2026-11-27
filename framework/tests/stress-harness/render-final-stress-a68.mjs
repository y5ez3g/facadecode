import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const [runDir, edition, destination] = process.argv.slice(2);
if (!runDir || !['short','full'].includes(edition) || !destination) {
    throw new Error('Supply the run directory, short or full, and the report path');
}
const scratch = path.resolve(process.env.STRESS_HARNESS_ROOT || path.join(os.tmpdir(), 'facade-148-stress'));
const root = path.join(scratch, 'evidence', 'a68-pr');
function read(file) {
    try {
        return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
}
const clean = value => String(value ?? '—').replace(/[|\r\n]/gu,ch => ch === '|' ? '\\|' : ' ');
const slash = value => value.replaceAll('\\','/');
const ref = (title,file) => file ? '['+title+'](<'+slash(file)+'>)' : '—';
const fmt = value => Number.isFinite(value) ? String(Math.round(value*1000)/1000) : '—';
const tally = counts => Object.entries(counts || {}).filter(([,n]) => n).map(([key,n]) => clean(key)+' '+n).join('、') || '—';
const red = row => Object.values(row.technical_failures || {}).some(n => n > 0) || Object.values(row.invariants || {}).some(n => n > 0);
const ratio = row => row?.sent != null ?
    (Number.isFinite(row.technical_success_percent) ? fmt(row.technical_success_percent)+'% ' : '')+
    '（'+row.confirmed+'/'+row.eligible+'，共 '+row.sent+'）' : '—';
const cpu = row => fmt(row?.machine_cpu_percent ?? row?.runner_cpu_percent);
const latency = row => {
    const q = row?.native_latency_ms ?? row?.latency_ms;
    return q ? [q.p50,q.p99,q.p999,q.max].map(fmt).join('/') : '—';
};
const status = read(path.join(runDir,'status.json'));
const plan = read(path.join(runDir,'plan.json'));
const smoke = read(path.join(runDir,'smoke-plan.json'));
const attempts = read(path.join(runDir,'attempts.json'));
if (!status?.candidate || !plan || !smoke || !attempts ||
    plan.final_commit !== status.candidate || smoke.candidate !== status.candidate) {
    throw new Error('The final candidate and both plans must identify the same frozen commit');
}
const before = 'af9bb4b8';
const head = status.candidate.slice(0,8);
const summaryDir = edition === 'short' ? path.join(runDir,'short') : runDir;
const reportPath = path.join(summaryDir,'report-pr7.json');
const replayFolders = ['quarantine','claude-i7','muse-capacity','b3-n2','crash-review'];
const capacityArgs = replayFolders.map(folder => path.join(runDir,folder,'review.json'))
    .filter(file => fs.existsSync(file)).flatMap(file => ['--capacity-review',file]);
execFileSync(process.execPath,[fileURLToPath(new URL('./report-pr-a68.mjs',import.meta.url)),
    '--kit','pr7','--out',summaryDir,...capacityArgs,'--baseline-history',before,head],{stdio:'inherit'});
const report = read(reportPath);
const archived = read(smoke.baseline_archive).datasets[before].rows;
const baselineRows = new Map(archived.filter(row => row.mode === 'full' && row.state === 'measured').map(row => [row.name,row]));
const allCurrent = report.datasets[head].rows;
const candidateRows = new Map();
const candidateByFile = new Map(allCurrent.filter(row => row.state === 'measured' && row.mode === 'full').map(row => [slash(row.evidence),row]));
const matrixPath = path.join(root,'timing-pairs-'+head+'-'+attempts.matrix.first+'.json');
for (const record of [read(matrixPath)].flat().filter(Boolean)) {
    const row = record.candidate?.evidence && candidateByFile.get(slash(record.candidate.evidence));
    if (row) candidateRows.set(row.name,row);
}
for (const row of allCurrent) {
    const ordinal = Number(/-a([0-9]{3})$/u.exec(row.evidence)?.[1]);
    if (row.mode === 'full' && row.state === 'measured' && ordinal >= attempts.matrix.first &&
        ordinal <= attempts.matrix.last && !candidateRows.has(row.name)) candidateRows.set(row.name,row);
}
const rows = plan.matrix.cases.map(({name}) => ({name,old:baselineRows.get(name),current:candidateRows.get(name)}));
const finished = rows.filter(row => row.current);
const reds = finished.filter(row => red(row.current));
const oldRedCount = smoke.baseline_red.filter(name => candidateRows.has(name)).length;
const real = finished.filter(({name}) => /^(claude|codex|agy|muse|opencode|pi) (idle|busy)\.$/u.test(name)).length;
const fast = report.fastQueue[head] ?? [];
const targeted = new Map(['targeted','targeted-retry'].flatMap(folder => read(path.join(runDir,folder,'targeted.json'))?.results || []).map(row => [row.fix,row]));
const testLabel = result => ({passed:'通过',failed:'失败',could_not_run:'未能运行'})[result] ?? '待完成';
const now = new Intl.DateTimeFormat('zh-CN',{timeZone:'America/Los_Angeles',dateStyle:'short',timeStyle:'medium'}).format(new Date());
const title = edition === 'short' ? 'PR 冒烟报告' + (oldRedCount < smoke.baseline_red.length ? '（阶段稿）' : '')
    : '最终压测报告' + (finished.length < rows.length ? '（部分结果）' : '');
const out = [
    '# Facade 148 '+title,'',
    '截至 '+now+' PST，修前 '+before+' 归档 222/222 格，修后 '+head+' 完成 **'+finished.length+'/222** 格。修后已判定格中 **'+reds.length+'** 格被裁判记为技术失败或不变量违规。修前 '+smoke.baseline_red.length+' 个红格已复测 '+oldRedCount+'，六家真 CLI 忙闲已完成 '+real+'/12 格。','',
    '修后使用冻结 pr7。修前沿用历史 pr2／pr4。调整后成功率的分母扣除有证据的 L1–L7、H1、H2。资源与时延列对应各轮实测负载，背靠背性能比较排到下一轮。 '+
        ref('逐格数据',reportPath)+' · '+ref('修前归档',smoke.baseline_archive)+' · '+ref('运行状态',path.join(runDir,'status.json')),'',
    '## 逐修复冒烟','',
    '| 修复 | 代表格 | 修后结果 | 证据 |','| --- | --- | --- | --- |',
];

const codexProbe = read(path.join(runDir,'codex-probes.json'));
if (codexProbe?.probes?.length) {
    const at = out.indexOf('## 逐修复冒烟');
    const lines = ['## Codex 单条探针','',
        '| 轮次 | Facade 回执 | 回环模型收到 | 原生会话保存 | 整机 CPU % | 回执 ms | 证据 |',
        '| ---: | --- | --- | --- | ---: | ---: | --- |'];
    for (const probe of codexProbe.probes) {
        lines.push('| '+probe.round+' | '+clean(probe.reason)+' | '+(probe.loopback ? '是' : '否')+' | '+
            (probe.native ? '是' : '否')+' | '+fmt(probe.cpu)+' | '+fmt(probe.elapsed_ms)+' | '+
            ref('隔离报告',path.join(probe.evidence,'h2-profile','profile.json'))+' |');
    }
    out.splice(at,0,...lines,'');
}

for (const folder of replayFolders) {
    const note = path.join(runDir,folder,'report-note.md');
    if (fs.existsSync(note)) out.splice(out.indexOf('## 逐修复冒烟'),0,fs.readFileSync(note,'utf8').trim(),'');
}

for (const [fix,proof] of Object.entries(smoke.fix_coverage).sort()) {
    const row = proof.scenario && candidateRows.get(proof.scenario);
    const test = targeted.get(fix);
    if (proof.test) out.push('| '+fix+' | '+clean(proof.test[2])+' | '+testLabel(test?.result)+' | '+ref('测试日志',test?.log)+' |');
    else if (proof.special) {
        const count = name => fast.find(pair => pair.name === name)?.candidate.rounds ?? 0;
        out.push('| '+fix+' | 快 attach/raw 队列 | '+count('H1 fast attach queue')+'/'+count('H1 fast raw queue')+' 对 | '+ref('专项回执与录像',reportPath)+' |');
    } else out.push('| '+fix+' | '+clean(proof.scenario)+' | '+(row ? red(row) ? '有违规' : '通过' : '待完成')+
        ' | '+ref('原始报告',row && path.join(root,row.evidence,'report.json'))+' |');
}
out.push('','## 快 attach/raw 对照','',
    '| 路径 | 版本 | 对数 | 送达 | L1 | 混交消息／轮 | I3／I4／I9 | 整机 CPU % |','| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const pair of fast) {
    for (const [version,side] of [[before,pair.baseline],[head,pair.candidate]]) {
        const values = side.cpu_percent.filter(Number.isFinite);
        const load = values.length ? fmt(Math.min(...values))+'–'+fmt(Math.max(...values)) : '—';
        out.push('| '+pair.name+' | '+version+' | '+side.rounds+' | '+side.delivered+'/'+side.attempted+
            ' | '+side.L1+' | '+side.mixed_messages+'/'+side.mixed_rounds+' | '+side.I3+'/'+side.I4+'/'+side.I9+' | '+load+' |');
    }
}
if (!fast.length) out.push('| 等待两侧录像 | — | — | — | — | — | — | — |');

const representative = new Set(smoke.representative);
const displayRows = edition === 'short'
    ? finished.filter(row => representative.has(row.name) || red(row.current) || row.current.queue_capacity_review)
    : rows;
out.push('','## 逐格正确性','',
    '| 场景 | 修前技术成功率 | 修后技术成功率 | 技术失败修前→修后 | 不变量修前→修后 | 证据 |',
    '| --- | --- | --- | --- | --- | --- |');
for (const {name,old,current} of displayRows) {
    const evidence = ref('修前',old && path.join(root,old.evidence,'report.json'))+' · '+ref('修后',current && path.join(root,current.evidence,'report.json'));
    out.push('| '+clean(name)+' | '+ratio(old)+' | '+ratio(current)+' | '+tally(old?.technical_failures)+' → '+
        (current ? tally(current.technical_failures) : '待测')+' | '+tally(old?.invariants)+' → '+
        (current ? tally(current.invariants) : '待测')+' | '+evidence+' |');
}
out.push('','## 逐格 CPU、内存和时延','',
    '时延依次为 p50/p99/p99.9/最大（ms）。真 CLI 有原生会话时间标记时使用该标记。','',
    '| 场景 | 整机 CPU % 修前→修后 | daemon CPU ms/条 修前→修后 | 私有内存 MiB 修前→修后 | 时延 ms 修前→修后 |',
    '| --- | ---: | ---: | ---: | --- |');
for (const {name,old,current} of displayRows) {
    out.push('| '+clean(name)+' | '+cpu(old)+' → '+cpu(current)+' | '+fmt(old?.daemon_cpu_ms_per_delivery)+' → '+
        fmt(current?.daemon_cpu_ms_per_delivery)+' | '+fmt(old?.daemon_private_mb)+' → '+fmt(current?.daemon_private_mb)+
        ' | '+latency(old)+' → '+latency(current)+' |');
}

function appendDetails(row) {
    out.push('','<details>','<summary>'+clean(row.name)+'</summary>','');
    if (row.technical_details?.length) {
        out.push('| 消息／序号 | 分类 | 回执／原因 | 正文／Enter 写达 |','| --- | --- | --- | --- |');
        for (const detail of row.technical_details) {
            const id = detail.number != null ? 'm'+detail.number : detail.seq != null ? '计划 '+detail.seq :
                detail.count ? detail.count+' 条汇总' : '—';
            out.push('| '+id+' | '+clean(detail.category)+' | '+clean(detail.receipt)+'／'+clean(detail.reason)+
                ' | '+clean(detail.text_written)+'／'+clean(detail.enter_written)+' |');
        }
        out.push('');
    } else if (Object.keys(row.technical_failures || {}).length) {
        out.push('裁判的崩溃轮分类统计 '+tally(row.technical_failures)+'。','');
    }
    for (const item of row.invariant_details ?? []) out.push('- '+clean(item.rule)+' '+clean(item.what));
    out.push('',ref('原始报告、录像位置及回执',path.join(root,row.evidence,'report.json')),'','</details>');
}
out.push('','## 修后技术失败逐条记录','');
if (reds.length && edition === 'full') {
    for (const {current} of reds) appendDetails(current);
} else if (reds.length) {
    out.push('逐条回执、判据和原始证据路径见 '+ref('结构化报告',reportPath)+'。');
} else {
    out.push('截至这份报告，已判定的修后格记录为零技术失败和零不变量违规。');
}
if (edition === 'full') {
    const baselineByFile = new Map(report.datasets[before].rows.map(row => [slash(row.evidence),row]));
    out.push('','## 修前技术失败逐条记录','');
    for (const row of baselineRows.values()) if (red(row)) appendDetails(baselineByFile.get(slash(row.evidence)) ?? row);
}
if (finished.length < rows.length) {
    const pending = smoke.baseline_red.filter(name => !candidateRows.has(name));
    out.push('','## 待完成','','修前红格剩余 '+pending.length+'，全矩阵剩余 '+(rows.length-finished.length)+'。');
    if (pending.length && edition === 'full') out.push('','修前红格 '+pending.map(clean).join('、')+'。');
}
out.push('', '逐轮记录见 '+ref('结构化报告',reportPath)+'。','');
fs.mkdirSync(path.dirname(destination),{recursive:true});
const pending = destination+'.'+process.pid+'.tmp';
fs.writeFileSync(pending,out.join('\n'));
fs.renameSync(pending,destination);
console.log(edition+' report '+finished.length+'/222, prior reds '+oldRedCount+'/'+smoke.baseline_red.length+
    ', candidate reds '+reds.length+', fast '+fast.map(item => item.candidate.rounds).join('/')+' at '+destination);
