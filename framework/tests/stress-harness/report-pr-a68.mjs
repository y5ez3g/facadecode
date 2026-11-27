import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const scratch = path.resolve(process.env.STRESS_HARNESS_ROOT || path.join(os.tmpdir(), 'facade-148-stress'));
const root = path.join(scratch, 'evidence', 'a68-pr');
const binRoot = path.join(scratch, 'bin');
const kits = ['pr2','pr3','pr4','pr5','pr6','pr7'];
const heads = process.argv.slice(2);
let selectedKit = null;
if (heads[0] === '--kit') {
    selectedKit = heads.splice(0, 2)[1];
    if (!kits.includes(selectedKit)) throw new Error('Supply a frozen kit after --kit');
}
let reportDirectory = root;
if (heads[0] === '--out') {
    const directory = heads.splice(0, 2)[1];
    if (!directory) throw new Error('Supply an output directory after --out');
    reportDirectory = path.resolve(directory);
}
const capacityReviewFiles = [];
while (heads[0] === '--capacity-review') {
    const file = heads.splice(0, 2)[1];
    if (!file) throw new Error('Supply the recorded queue capacity review');
    capacityReviewFiles.push(file);
}
const includeBaselineHistory = heads[0] === '--baseline-history';
if (includeBaselineHistory) heads.shift();
if (!heads.length || heads.some(head => !/^[0-9a-f]{8}$/u.test(head))) throw new Error('Supply the tested eight-character product heads');
const [baseline, ...next] = heads;
const frozen = path.join(binRoot, `stress-a68-${selectedKit ?? 'pr2'}-harness`);
const reportName = selectedKit ? `report-${selectedKit}` : 'report';
const clis = ['claude','codex','agy','muse','opencode','pi'];
const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')) : null;
const capacityReviews = new Map();
for (const file of capacityReviewFiles) {
    const review = read(file);
    if (!review?.evidence || !review.rows?.length) throw new Error(`Missing queue capacity review rows in ${file}`);
    const evidence = path.resolve(root, review.evidence);
    if (capacityReviews.has(evidence)) throw new Error(`Conflicting queue capacity reviews for ${evidence}`);
    capacityReviews.set(evidence, {...review, file});
}
const plan = read(path.join(frozen, 'fake-cases.json'));
const harnesses = Object.fromEntries(kits.map(kit => {
    const file = path.join(binRoot, `stress-a68-${kit}-harness`, 'STORM_HEAD');
    return [kit, fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null];
}));
const grid = plan.stages.flatMap(stage => stage.scenarios.map(name => ({name, group:stage.label})));
const categories = new Set(['L1','L2','L3','L4','L5','L6','L7']);
const round = value => Number(value.toFixed(3));
const add = (counts, key, n = 1) => { counts[key] = (counts[key] || 0) + n; };

function quantiles(values) {
    const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
    if (!sorted.length) return null;
    const q = p => round(sorted[Math.ceil(p * sorted.length) - 1]);
    return {count:sorted.length, p50:q(.5), p95:q(.95), p99:q(.99), p999:q(.999), max:q(1)};
}

function applyDrawingBudgets(stage, dir) {
    const adjustments = new Map();
    const excluded = new Set();
    if (!stage.evidence || !stage.violations?.length || /^(claude|codex|agy|muse|opencode|pi) (idle|busy)\.$/u.test(stage.name)) {
        return {adjustments, excluded};
    }
    const evidence = path.resolve(stage.evidence);
    if (!evidence.toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)) return {adjustments, excluded};
    const ledger = read(path.join(evidence, 'ledger.json'));
    const spec = ledger?.storm || '';
    const draw = Number(/\bdraw_ms:\s*(\d+)/u.exec(spec)?.[1] ?? 0);
    const echo = Number(/\("FAKECLI_ECHO_MS",\s*"(\d+)"\)/u.exec(spec)?.[1] ?? 0);
    const redrawing = draw + echo;
    if (!redrawing) return {adjustments, excluded};
    for (const violation of stage.violations) {
        if (violation.rule === 'I13' && !violation.what.includes('its redraw after submitting')) {
            const lag = /reached the CLI (\d+) ms late, beyond the (\d+) ms/u.exec(violation.what);
            if (lag && Number(lag[2]) > 200 && Number(lag[1]) <= Number(lag[2]) + redrawing) {
                excluded.add(violation);
                adjustments.set(violation, {rule:'I13', measured_ms:Number(lag[1]), budget_ms:Number(lag[2])+redrawing,
                    raw:violation.what});
            }
        }
        if (stage.name === 'B1 paste in chunks, echo 200 ms' && violation.rule === 'I15') {
            const held = /^m(\d+) .*input_draft text_written=none enter_written=Some\(false\); the input was free for (\d+) ms .* and (\d+) before it/u.exec(violation.what);
            const needed = held && (Number(held[3])+1) * (86+2*redrawing)*1.2;
            if (held && Number(held[2]) < 29_500 && Number(held[2]) < needed) {
                excluded.add(violation);
                adjustments.set(violation, {rule:'I15', number:Number(held[1]), category:'L1',
                    available_ms:Number(held[2]), needed_ms:round(needed), raw:violation.what});
            }
        }
    }
    return {adjustments, excluded};
}

function queueCapacity(capacityReview, product, stage) {
    const adjustments = new Map();
    if (!capacityReview) return adjustments;
    if (capacityReview.product !== product || capacityReview.scenario !== stage.name) {
        throw new Error('Queue capacity evidence belongs to a different product or scenario');
    }
    for (const proof of capacityReview.rows) {
        const message = stage.stats?.messages?.find(row => row.number === proof.number);
        const violation = stage.violations?.find(row => row.rule === 'I15' && row.what === proof.raw_i15 &&
            row.what.startsWith(`m${proof.number} `));
        if (!message || !violation || adjustments.has(violation) || proof.category !== 'L1' ||
            !Number.isInteger(proof.margin_upper_us) || proof.margin_upper_us >= 0 ||
            proof.deadline_upper_us - proof.required_through_us !== proof.margin_upper_us ||
            message.category !== proof.original_category || message.status !== proof.status ||
            message.text_written !== proof.text_written || message.enter_written !== false || proof.enter_written !== false) {
            throw new Error(`Queue capacity review does not match the record for m${proof.number}`);
        }
        adjustments.set(violation, proof);
    }
    return adjustments;
}

function messageResults(stats, dir, drawingAdjustments, queueAdjustments) {
    if (!Array.isArray(stats.messages)) return null;
    const messages = stats.messages.filter(message => message.number == null || message.number !== stats.notes?.fixture_startup_message);
    const exceptions = read(path.join(dir, 'exception-evidence.json')) || [];
    const byMessage = new Map([...drawingAdjustments.values()].filter(row => row.number != null).map(row => [row.number,row.category]));
    const queueByMessage = new Map([...queueAdjustments.values()].map(row => [row.number,row.category]));
    const end = {attempted:messages.length, verified:0, receipt_success:0, justified:{}, H1:0, H2:0,
        technical:{}, technical_details:[], unverified:0, latency:[], observedLatency:[], call:[]};
    for (const message of messages) {
        const proof = exceptions.find(item => message.number != null && item.number === message.number &&
            ['H1','H2'].includes(item.category) && typeof item.evidence === 'string' && item.evidence.trim());
        if (message.status === 'success') end.receipt_success++;
        if (message.category === 'delivered') {
            end.verified++;
            end.latency.push(message.latency_ms);
            end.observedLatency.push(message.observed_latency_ms);
        } else if (categories.has(message.category)) add(end.justified, message.category);
        else if (queueByMessage.has(message.number)) add(end.justified, queueByMessage.get(message.number));
        else if (byMessage.has(message.number) && message.category === 'input_draft') add(end.justified, byMessage.get(message.number));
        else if (message.category === 'unverified_session') end.unverified++;
        else if (proof) end[proof.category]++;
        else {
            add(end.technical, message.category);
            end.technical_details.push({number:message.number, seq:message.seq, category:message.category,
                reason:message.reason, receipt:message.status, text_written:message.text_written, enter_written:message.enter_written});
        }
        end.call.push(message.call_ms);
    }
    if (Number.isInteger(stats.notes?.start_requests) && stats.notes.start_requests > end.attempted) {
        const missing = stats.notes.start_requests - end.attempted;
        add(end.technical, 'start_request_failed', missing);
        end.technical_details.push({category:'start_request_failed', count:missing});
        end.attempted = stats.notes.start_requests;
    }
    return end;
}

function crashResults(stats) {
    const kinds = stats.first_messages || stats.told;
    if (!kinds) return null;
    const expected = stats.starts ?? stats.ended;
    const result = {attempted:expected, verified:0, receipt_success:null, justified:{}, H1:0, H2:0,
        technical:{}, unverified:0, latency:stats.delivery_latency_ms || [], call:[]};
    let counted = 0;
    for (const [kind, number] of Object.entries(kinds)) {
        counted += number;
        if (kind === 'whole, once' || /^told 1 times(?:,|$)/u.test(kind)) result.verified += number;
        else add(result.technical, kind, number);
    }
    if (counted < expected) add(result.technical, 'no matching target', expected - counted);
    return result;
}

function resources(stats, count) {
    const notes = stats.notes || {};
    const tracked = stats.daemon_case;
    const steady = notes.traffic_daemon || notes.traffic_load?.daemon;
    const whole = tracked?.before_stop;
    const generations = stats.daemon_generations;
    const restartCpu = Array.isArray(generations) && generations.every(sample => Number.isFinite(sample?.cpu_ms))
        ? generations.reduce((total, sample) => total + sample.cpu_ms, 0) : null;
    const cpu = steady?.cpu_ms ?? whole?.cpu_ms ?? restartCpu;
    const samples = generations?.map(sample => sample?.private_mb).filter(Number.isFinite);
    const live = tracked?.live_agents;
    const machine = notes.traffic_machine_cpu_percent ?? notes.traffic_load?.machine_cpu_percent ??
        notes.machine_cpu_percent ?? stats.machine_cpu_percent ?? null;
    const hogs = notes.traffic_load?.hogs ?? (generations ? 14 : 0);
    return {sample_window:steady ? 'traffic' : whole ? 'case before stopping agents' : generations ? 'daemon generations' : null,
        machine_cpu_percent:machine, controlled_hogs:hogs,
        quiet_timing_eligible:hogs === 0 && Number.isFinite(machine) && machine <= 60,
        daemon_cpu_ms:cpu ?? null, daemon_cpu_ms_per_delivery:count && Number.isFinite(cpu) ? round(cpu/count) : null,
        daemon_private_mb:whole?.private_mb ?? steady?.private_mb ?? (samples?.length ? Math.max(...samples) : null),
        daemon_private_mb_per_live_agent:live && Number.isFinite(whole?.private_mb_grew) ? round(whole.private_mb_grew/live) : null,
        daemon_private_mb_after_stop:tracked?.after_stop?.private_mb ?? null,
        daemon_private_mb_change_after_stop:tracked?.after_stop?.private_mb_grew ?? null,
        live_agents:live ?? null, daemon_generations:generations ?? null};
}

function readTrial(file) {
    try {
        return read(file);
    } catch (error) {
        if (error instanceof SyntaxError) return null;
        throw error;
    }
}

function cell(dir, head, name) {
    const base = {name, evidence:path.relative(root, dir)};
    const run = readTrial(path.join(dir, 'run.json'));
    if (!run) return {...base, state:'incomplete'};
    const [ , kit, runHead] = /^stress-a68-(pr2|pr3|pr4|pr5|pr6|pr7)-([0-9a-f]{8})$/u.exec(run.bin || '') || [];
    if (selectedKit && kit !== selectedKit && !(includeBaselineHistory && head === baseline && kit)) return null;
    const report = readTrial(path.join(dir, 'report.json'));
    if (!report) return {...base, state:'incomplete'};
    const stamp = kit ? path.join(binRoot, run.bin, 'HEAD') : '';
    const product = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8').trim() : null;
    if (runHead !== head || !product || report.head !== product || report.storm_head !== harnesses[kit] ||
        report.storms?.length !== 1 || report.storms[0].name !== name) {
        return {...base, state:'provenance mismatch'};
    }
    const stage = report.storms[0];
    if (stage.could_not_run) return {...base, state:'could not run', error:stage.could_not_run, runner_cpu_percent:run.machine_cpu_percent};
    if (![0,1].includes(run.exit_code)) return {...base, state:'runner failed', exit_code:run.exit_code};
    const stats = stage.stats || {};
    const drawing = applyDrawingBudgets(stage,dir);
    const capacityReview = capacityReviews.get(path.resolve(dir));
    const queue = queueCapacity(capacityReview, product, stage);
    const result = messageResults(stats, dir, drawing.adjustments, queue) || crashResults(stats);
    const technical = result?.technical ?? {};
    const eligible = result && result.attempted - Object.values(result.justified).reduce((sum,n) => sum+n,0) - result.H1 - result.H2;
    const guards = {};
    const violations = (stage.violations || []).filter(violation => !drawing.excluded.has(violation) && !queue.has(violation));
    for (const violation of violations) add(guards, violation.rule);
    const phase = /^(claude|codex|agy|muse|opencode|pi) (idle|busy)\.$/u.exec(name)?.[2];
    const actual = stats.notes?.state?.as_sent ?? null;
    const wrongState = phase === 'busy' && actual !== 'working' || phase === 'idle' && !['idle','just_done'].includes(actual);
    const shape = phase && /^\w+-(?:idle|busy)-(5|50)-a\d{3}$/u.exec(path.basename(dir))?.[1];
    const wrongCount = phase && (!shape || result?.attempted !== Number(shape));
    const state = wrongCount ? 'wrong sender count' : wrongState ? 'wrong initial state' :
        result?.unverified ? 'unverified session evidence' : 'measured';
    return {...base, kit, harness:report.storm_head, state,
        sent:result?.attempted ?? null, confirmed:result?.verified ?? null, eligible:eligible ?? null,
        raw_success_percent:result?.attempted > 0 && !result.unverified ? round(100 * result.verified / result.attempted) : null,
        technical_success_percent:eligible > 0 && !result.unverified ? round(100 * result.verified / eligible) : null,
        receipt_success:result?.receipt_success ?? null, reasonable:result?.justified ?? {},
        H1:result?.H1 ?? 0, H2:result?.H2 ?? 0, unverified:result?.unverified ?? 0, technical_failures:technical,
        invariants:guards, drawing_rejudgments:[...drawing.adjustments.values()],
        ...(queue.size ? {queue_capacity_review:{file:capacityReview.file, rows:[...queue.values()]}} : {}),
        ...(includeBaselineHistory ? {technical_details:result?.technical_details ?? [], invariant_details:violations} : {}),
        latency_ms:quantiles(result?.latency || []), native_latency_ms:quantiles(result?.observedLatency || []),
        send_call_ms:quantiles(result?.call || []),
        start_state:actual,
        runner_cpu_percent:run.machine_cpu_percent ?? null, ...resources(stats, result?.verified)};
}

function entries(folder) {
    return fs.existsSync(folder)
        ? fs.readdirSync(folder, {withFileTypes:true}).filter(entry => entry.isDirectory()).sort((a,b) => a.name.localeCompare(b.name))
        : [];
}

const datasets = {};
for (const head of heads) {
    const headRoot = path.join(root, head);
    const rows = [];
    for (const [folder, mode] of [['fake-full','full'],['fake-pilot','pilot']]) {
        for (const entry of entries(path.join(headRoot, folder))) {
            const id = /^c(\d+)-a\d{3}$/u.exec(entry.name);
            const scenario = id && grid[Number(id[1])-1];
            if (!scenario) continue;
            const row = cell(path.join(headRoot,folder,entry.name),head,scenario.name);
            if (row) rows.push({mode, suite:scenario.group, ...row});
        }
    }
    for (const entry of entries(path.join(headRoot, 'real'))) {
        const found = /^(claude|codex|agy|muse|opencode|pi)-(idle|busy)-(5|50)-a\d{3}$/u.exec(entry.name);
        if (!found) continue;
        const row = cell(path.join(headRoot,'real',entry.name),head,`${found[1]} ${found[2]}.`);
        if (row) rows.push({mode:found[3] === '50' ? 'full' : 'pilot', suite:'real', ...row});
    }
    const expected = [...grid.map(row => [row.group,row.name]), ...clis.flatMap(cli => ['idle','busy'].map(state => ['real',`${cli} ${state}.`]))];
    const full = rows.filter(row => row.mode === 'full' && row.state === 'measured');
    const missing = expected.filter(([suite,name]) => !full.some(row => row.suite === suite && row.name === name));
    datasets[head] = {expected_full:expected.length, measured_full:expected.length-missing.length, missing_full:missing, rows};
    console.log(`${head} full ${expected.length-missing.length}/${expected.length}, pilot ${rows.filter(row => row.mode === 'pilot' && row.state === 'measured').length}`);
}
const normalize = evidence => evidence.replace(/\\/gu, '/');
const recordedPairs = new Map();
for (const file of fs.readdirSync(root).filter(name => /^timing-pairs-[a-f0-9]{8}-\d+\.json$/u.test(name))) {
    const records = readTrial(path.join(root,file));
    for (const pair of records ? [records].flat() : []) {
        if (pair.candidate?.evidence) recordedPairs.set(normalize(pair.candidate.evidence), pair);
    }
}
const delta = (a,b) => Number.isFinite(a) && Number.isFinite(b) ? round(b-a) : null;
const comparisons = Object.fromEntries(next.map(head => [head, datasets[head].rows.filter(row => row.mode === 'full' && row.state === 'measured')
    .flatMap(row => {
        const pair = recordedPairs.get(normalize(row.evidence));
        const candidates = datasets[baseline].rows.filter(item => item.mode === 'full' && item.state === 'measured' &&
            item.suite === row.suite && item.name === row.name);
        const paired = pair?.baseline && candidates.find(item => normalize(item.evidence) === normalize(pair.baseline.evidence));
        const historical = includeBaselineHistory && candidates.find(item => item.kit !== selectedKit);
        const old = paired || historical || candidates.filter(item => item.harness === row.harness).at(-1);
        const sameLoad = Boolean(paired && pair.comparable && old.harness === row.harness);
        return old ? [{suite:row.suite, name:row.name, baseline:old.evidence, candidate:row.evidence,
            baseline_kit:old.kit, candidate_kit:row.kit, same_judge:old.harness === row.harness,
            baseline_cpu_percent:paired ? pair.baseline.measured_cpu : old.machine_cpu_percent ?? old.runner_cpu_percent,
            candidate_cpu_percent:pair?.candidate?.measured_cpu ?? row.machine_cpu_percent ?? row.runner_cpu_percent,
            baseline_ambient_cpu_percent:paired ? pair.baseline.ambient_cpu : null,
            candidate_ambient_cpu_percent:pair?.candidate?.ambient_cpu ?? null,
            success_points:delta(old.technical_success_percent,row.technical_success_percent),
            cpu_ms_per_delivery_delta:sameLoad || !includeBaselineHistory ? delta(old.daemon_cpu_ms_per_delivery,row.daemon_cpu_ms_per_delivery) : null,
            private_mb_delta:delta(old.daemon_private_mb,row.daemon_private_mb),
            timing_load_matched:sameLoad, paired_mode:paired ? pair.mode ?? 'timing' : null,
            pair_gap_seconds:paired ? pair.gap_seconds : null,
            p99_ms_delta:sameLoad ? delta(old.latency_ms?.p99,row.latency_ms?.p99) : null}] : [];
    })]));

function fastQueueTrial(row) {
    if (!row) return null;
    const folder = path.resolve(root, row.evidence);
    const stage = read(path.join(folder, 'report.json'))?.storms?.[0];
    if (!stage?.evidence || row.sent !== 20) return null;
    const recorded = path.resolve(stage.evidence);
    const tape = path.join(recorded, 'tapes', 'a1.tape');
    if (!recorded.toLowerCase().startsWith(folder.toLowerCase() + path.sep) || !fs.existsSync(tape)) return null;
    const mixed = new Map();
    for (const finding of stage.violations || []) {
        if (finding.rule !== 'I4' || !/p-\d{4}(?:\s|$)/u.test(finding.what)) continue;
        const numbers = /messages \[([\d, ]+)\]/u.exec(finding.what)?.[1];
        if (!numbers) continue;
        for (const number of numbers.split(',').map(Number)) {
            const message = stage.stats.messages.find(item => item.number === number);
            if (message) mixed.set(number, {number, reason:message.reason, category:message.category,
                text_written:message.text_written, enter_written:message.enter_written, evidence:finding.what});
        }
    }
    return {evidence:row.evidence, tape:path.relative(root,tape), attempted:row.sent, delivered:row.confirmed,
        L1:row.reasonable.L1 || 0, mixed:[...mixed.values()], findings:row.invariants,
        cpu:row.machine_cpu_percent ?? row.runner_cpu_percent};
}

function fastQueueTotals(trials) {
    const totals = {rounds:trials.length, attempted:0, delivered:0, L1:0, mixed_rounds:0, mixed_messages:0,
        I3:0, I4:0, I9:0, cpu_percent:[], trials};
    for (const trial of trials) {
        for (const key of ['attempted','delivered','L1']) totals[key] += trial[key];
        for (const key of ['I3','I4','I9']) totals[key] += trial.findings[key] || 0;
        totals.mixed_rounds += Number(trial.mixed.length > 0);
        totals.mixed_messages += trial.mixed.length;
        totals.cpu_percent.push(trial.cpu);
    }
    return totals;
}

const fastQueue = {};
for (const [head, pairs] of Object.entries(comparisons)) {
    const rechecks = [];
    for (const name of ['H1 fast attach queue','H1 fast raw queue']) {
        const matched = pairs.filter(pair => pair.name === name &&
            (pair.paired_mode === 'check-pairs' || pair.timing_load_matched));
        if (!matched.length) continue;
        const valid = [];
        const missingTape = [];
        for (const pair of matched) {
            const old = fastQueueTrial(datasets[baseline].rows.find(row => row.evidence === pair.baseline));
            const newer = fastQueueTrial(datasets[head].rows.find(row => row.evidence === pair.candidate));
            if (old && newer) valid.push([old,newer]);
            else missingTape.push({baseline:pair.baseline, candidate:pair.candidate});
        }
        rechecks.push({name, required_rounds:10, baseline:fastQueueTotals(valid.map(pair => pair[0])),
            candidate:fastQueueTotals(valid.map(pair => pair[1])), missing_tape:missingTape});
    }
    if (rechecks.length) fastQueue[head] = rechecks;
}
fs.mkdirSync(reportDirectory, {recursive:true});
fs.writeFileSync(path.join(reportDirectory, `${reportName}.json`), JSON.stringify({selectedKit, includeBaselineHistory, harnesses, baseline, datasets, comparisons, fastQueue}, null, 2) + '\n');

const show = value => value ?? '—';
const tallies = values => Object.entries(values).map(([key, value]) => `${key} ${value}`).join('、') || '—';
const times = row => row.latency_ms
    ? [row.latency_ms.p50, row.latency_ms.p95, row.latency_ms.p99, row.latency_ms.p999, row.latency_ms.max].join(' / ')
    : '—';
const markdown = [
    '# 148 消息投递 PR 压测', '',
    '普通场景按正文逐字一致、仅一次、收方正确和回执一致核验成功。调整后分母扣除证据支持的 L1–L7、H1、H2。',
    'Z1 按首条消息正文逐字一致且仅一次核验，时延为开始调用至原生提交。Z2 按应告知对象实际收到且仅收到一次核验，时延为发起停止至收到通知。',
    '整机 CPU 采用投递段样本，缺失时列运行全段样本并加星号。CPU ms/条采用 daemon CPU 样本除以核验送达数。',
    '内存为 daemon 私有提交量。时延依次为 p50、p95、p99、p99.9、max，来自核验成功的消息。普通场景使用回执时刻，汇总 JSON 也记录可核验原生时间戳的时延。',
    '— 表示该场景无适用分母或该样本无可核验数据。', ''
];
for (const [head, data] of Object.entries(datasets)) {
    markdown.push(`## ${head}`, '', `正式规格有效 ${data.measured_full}/${data.expected_full} 格。`, '');
    markdown.push('| 场景 | 成功/尝试 | 成功/调整分母 | 调整后成功率 % | 技术失败 | 裁判规则 | 扣除 | 整机 CPU % | daemon CPU ms/条 | 内存 MiB | 时延 ms |',
        '| --- | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | --- |');
    const selected = new Map();
    for (const row of data.rows.filter(row => row.state === 'measured')) {
        selected.set(`${row.mode}\0${row.suite}\0${row.name}`, row);
    }
    for (const row of selected.values()) {
        const exceptions = {...row.reasonable};
        if (row.H1) exceptions.H1 = row.H1;
        if (row.H2) exceptions.H2 = row.H2;
        const cpu = row.machine_cpu_percent ?? (row.runner_cpu_percent == null ? '—' : `${row.runner_cpu_percent}*`);
        const display = `${row.mode === 'pilot' ? '小样本 · ' : ''}${row.name}`.replaceAll('|', '\\|');
        const record = `${root}/${row.evidence.replaceAll('\\', '/')}/report.json`;
        const raw = row.sent == null ? '—' : `${row.confirmed}/${row.sent}${row.raw_success_percent == null ? '' : ` (${row.raw_success_percent}%)`}`;
        markdown.push(`| [${display}](${record}) | ${raw} | ` +
            `${row.eligible == null ? '—' : `${row.confirmed}/${row.eligible}`} | ${show(row.technical_success_percent)} | ` +
            `${tallies(row.technical_failures)} | ${tallies(row.invariants)} | ${tallies(exceptions)} | ${cpu} | ${show(row.daemon_cpu_ms_per_delivery)} | ` +
            `${show(row.daemon_private_mb)} | ${times(row)} |`);
    }
    markdown.push('');
}
for (const [head, pairs] of Object.entries(comparisons)) {
    if (!pairs.length) continue;
    markdown.push(`## ${baseline} → ${head}`, '',
        'p99 差值来自同裁判、同负载的配对。安静轮的整机 CPU 均 ≤60%，受控满载轮的占核数相同且测得 CPU 均 ≥95%。', '',
        '| 场景 | 修前／修后裁判 | 修前／修后整机 CPU % | 成功率变化百分点 | daemon CPU ms/条变化 | 内存 MiB 变化 | p99 ms 变化 |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const pair of pairs) {
        markdown.push(`| ${pair.name.replaceAll('|', '\\|')} | ${pair.baseline_kit}／${pair.candidate_kit} | ` +
            `${show(pair.baseline_cpu_percent)}／${show(pair.candidate_cpu_percent)} | ${show(pair.success_points)} | ` +
            `${show(pair.cpu_ms_per_delivery_delta)} | ${show(pair.private_mb_delta)} | ${show(pair.p99_ms_delta)} |`);
    }
    markdown.push('');
}
for (const [head, rechecks] of Object.entries(fastQueue)) {
    markdown.push(`## ${baseline} → ${head}，H1 快速输入时已有队列`, '',
        'attach 与 raw 各需至少十对。混交按 I4 中同一次提交同时出现测试人键和 Facade 消息编号计数。', '',
        '| 路线 | 版本 | 有效轮 / 要求 | 送达 | L1 | 混交消息 / 混交轮 | I3 / I4 / I9 | 整机 CPU % |',
        '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of rechecks) {
        for (const [version, side] of [[baseline,row.baseline],[head,row.candidate]]) {
            const cpus = side.cpu_percent.filter(Number.isFinite);
            const cpu = cpus.length ? `${Math.min(...cpus)}–${Math.max(...cpus)}` : '—';
            markdown.push(`| ${row.name} | ${version} | ${side.rounds} / ${row.required_rounds} | ` +
                `${side.delivered} / ${side.attempted} | ${side.L1} | ${side.mixed_messages} / ${side.mixed_rounds} | ` +
                `${side.I3} / ${side.I4} / ${side.I9} | ${cpu} |`);
        }
    }
    markdown.push('', `逐轮回执及录像路径见 [汇总 JSON](${reportDirectory.replaceAll('\\', '/')}/${reportName}.json)。`, '');
}
fs.writeFileSync(path.join(reportDirectory, `${reportName}.md`), markdown.join('\n') + '\n');
