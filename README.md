# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/victory-c/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/victory-c/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one dependency-free Node 22 CLI (`main.ts`) that applies AI-written edits to a tree of files — unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor calls — with three-tier fuzzy line matching, re-indentation, CRLF/no-final-newline handling, and all-or-nothing writes.

## Run it

```sh
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]
node check.ts practice.json   # kit practice set
node tests/cases.ts           # spec edge cases
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=dsps50bd&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
