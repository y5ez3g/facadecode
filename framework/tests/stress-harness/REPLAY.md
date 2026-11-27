# Facade 148 stress harness

This branch preserves the PR7 judge, fake CLI, Windows matrix driver, and synthetic loopback fixtures. The judge is the exact source used for `832a65ba1b41e3bbf82442886b4696eb76bc6cf8+pr-ce877da8bef2`. Builds, reports, profile attestations, and terminal recordings go to the scratch directory.

## Replay the full matrix

Use Windows x64 with Git, Node.js, Windows PowerShell, and the repository's Rust/MSVC toolchain and Cargo dependencies. The Rust drivers build with debug assertions in the release profile because the fake CLI rules depend on them. Keep at least 8 GiB free on the scratch drive.

The real CLI cells use the Claude, Codex, agy, Muse, OpenCode, and Pi entrypoints on the test runner's PATH. The real runner requires an isolated profile and a receipt from the loopback model before collecting a cell. Use the audited CLI versions and isolated installations. The Windows Pi fixture expects the Pi 1.4.0 layout.

Set the scratch and shared timing lock paths for the test machine. On the original lab host, run from this checkout with the candidate commit available to Git.

```powershell
$env:STRESS_HARNESS_ROOT = 'D:\tmp\d24-148\stress-harness-replay'
$env:STRESS_HARNESS_LOCK = 'D:\tmp\d24-148\perf.lock'
$runner = '.\framework\tests\stress-harness\run-pr-overnight-a68.ps1'
& $runner -RunName pr7-replay-001 -FinalHead 9a0d93a0 -NoTiming
```

Append `-PlanOnly` to inspect the pinned inputs and the 222 cases. Use a fresh run name for each run. `-NoTiming` replays the correctness matrix of 210 fake and 12 real CLI cells, plus ten paired fast-queue trials on each of the attach and raw paths. The runner uses `af9bb4b8` for the comparison pairs. For a fresh 222-cell baseline, prepare and run that revision separately.

```powershell
$suite = '.\framework\tests\stress-harness'
& "$suite\prepare-pr-a68.ps1" -Head af9bb4b8 -Kit pr7
& "$suite\run-pr-a68.ps1" -Head af9bb4b8 -Kit pr7 -Stage all -Attempt a200 -LastAttempt 202
```

An isolated trial writes its `run.json`, `report.json`, and recordings below `evidence/a68-pr` in the scratch directory. The supervisor writes `plan.json`, `coverage.json`, and `report-pr7.json` below `evidence/a68-pr-overnight/<RunName>`. Create a `stop-after-cell` file in that run directory to stop at the next scenario boundary.

## Resume the interrupted run

Defender quarantined the frozen `9a0d93a0` executable with detection `Trojan:Win32/Bearfoos.A!ml`. To finish the original 74 cells, use an approved isolated Windows runner where the artifact has been cleared through finding 022 and the same frozen executable and judge hashes can be used. Keep the original 148 results with their original provenance. The affected commit must be available in the replay checkout.

`datasets.9a0d93a0.missing_full` in the saved `report-pr7.json` identifies the pending scenarios. `run-pr-pairs-a68.ps1 -Mode matrix -NoTiming -CaseListFile` accepts a JSON array of scenario names and an unused attempt range. A changed product build starts a separate matrix.
