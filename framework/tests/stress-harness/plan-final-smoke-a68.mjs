import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const [commit, output] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/u.test(commit ?? '') || !output) throw new Error('Supply the full candidate commit and a plan path');
const root = path.resolve(process.env.STRESS_HARNESS_ROOT || path.join(os.tmpdir(), 'facade-148-stress'));
const evidence = path.join(root, 'evidence', 'a68-pr');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const oldReport = path.join(evidence, 'report.json');
const baseline = read(oldReport).datasets.af9bb4b8;
const cases = read(path.join(root,'bin','stress-a68-pr7-harness','fake-cases.json')).stages.flatMap(stage => stage.scenarios);
const clis = ['claude','codex','agy','muse','opencode','pi'];
const real = clis.flatMap(cli => ['idle','busy'].map(state => cli + ' ' + state + '.'));
if (baseline.measured_full !== 222 || cases.length + real.length !== 222) throw new Error('The 222 archived baseline cells or the pr7 grid are incomplete');

const fixCoverage = {
    '001': {scenario:'H1 fast attach queue', special:'attach and raw'},
    '002': {scenario:'busy every 10 ms, sync 1'},
    '003': {scenario:'B1 paste in chunks, echo 200 ms'},
    '004': {test:['facade-daemon','lib','agent::typist::tests::a_paste_gets_its_enter_when_the_cli_draws_its_text_in_another_shape']},
    '006': {scenario:'pi busy.'},
    '008': {scenario:'W8 600 waits at once'},
    '009': {scenario:'codex idle.'},
    '010': {test:['facade-screen','lib','tests::a_tab_kept_in_a_cell_draws_nothing']},
    '011': {test:['facade-rules','input','pi_screens_read_as_recorded']},
    '014': {test:['facade-daemon','lib','agent::actor::tests::a_later_draft_edit_still_blocks_proof_after_a_native_wait_report']},
    '016': {test:['facade-scenarios','notices','a_saved_exit_and_an_exit_during_a_crash_each_reach_the_creator_once']},
    '017': {test:['facade-rules','input','claude_plain_hint_and_same_text_draft_need_the_probe']},
    '018': {test:['facade-daemon','lib','agent::actor::tests::a_late_probe_that_redraws_an_empty_box_allows_the_next_paste']},
    '020': {scenario:'S1 10 starts with a first message'},
    '023': {test:['facade-rules','input','claude_queue_notice_leaves_the_input_usable']},
    '024': {test:['facade-scenarios','mcp','keys_typed_while_an_antigravity_start_readies_its_tools_wait_for_it']},
    '025': {test:['facade-daemon','lib','agent::actor::tests::a_frame_left_unread_when_recovered_cleanup_begins_is_no_cleanup_evidence']},
    '026': {test:['facade-scenarios','notices','a_settled_notice_recovers_its_unfinished_cleanup_without_reopening_the_receipt']},
    '028': {test:['facade-base','lib','platform::terminal::tests::ready_output_includes_bytes_a_read_under_way_has_taken']},
};
const representative = [...new Set([...real, ...Object.values(fixCoverage).filter(fix => fix.scenario && !fix.special).map(fix => fix.scenario)])];
const baselineRed = baseline.rows.filter(row => row.mode === 'full' && row.state === 'measured' &&
    (Object.values(row.technical_failures).some(n => n > 0) || Object.values(row.invariants).some(n => n > 0))).map(row => row.name);
const required = new Set([...baselineRed, ...representative]);
const remainingRed = cases.filter(name => baselineRed.includes(name) && !representative.includes(name));
for (const label of required) {
    if (![...cases,...real].includes(label)) throw new Error('A smoke scenario is missing from the frozen grid: ' + label);
}
if (new Set([...representative,...remainingRed]).size !== required.size) throw new Error('A baseline red cell was lost');
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, JSON.stringify({
    candidate:commit, baseline_archive:oldReport, baseline_red:baselineRed,
    representative, remaining_red:remainingRed, fix_coverage:fixCoverage,
    fast_pairs_per_scenario:5,
}, null, 2) + '\n');
console.log('PR smoke: ' + representative.length + ' first matrix cells, ' + remainingRed.length +
    ' other baseline red cells, ' + Object.keys(fixCoverage).length + ' fixes, 5 attach and 5 raw pairs');
