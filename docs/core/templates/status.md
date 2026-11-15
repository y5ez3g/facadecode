# <Feature>: status

<!-- The General TL keeps this file where the owner asked. The owner reads it top to bottom; the first section must
stand alone. Every time comes from `date`. -->

## Read this first (<time>)

<Three to five lines: where the work stands, the root branch and its head, what the owner must do now.>

## Changes since <time>

- <time> <what changed, with commit IDs>.

## Timeline

| Time | What happened |
| --- | --- |

## Roles

| Role | Agent | State |
| --- | --- | --- |
| General TL | <#aN> | |
| Bar raiser TL | <#aN> | |
| Review TL | <#aN> | |
| QA lead | <#aN> | |

## Islands

| Island | Owner | Freeze | Started | Done | Integrated |
| --- | --- | --- | --- | --- | --- |

## Commits on the root branch

<`git log --oneline <base>..<head>`, oldest last, with one line on what each island's commit holds.>

## Tests

- Full run: `core/scripts/test-all.sh` at <head>: <passed>, <failed>, <processes left>.
- Each commit: `core/scripts/check-each-commit.sh <base> <head>`: <result>.
- Stress: <measures against their targets>.

## Review and QA

<Each finding: severity, where, which island, fixed in which commit, or why it stays.>

## Features

| # | Feature | State |
| --- | --- | --- |

## For the owner

<Numbered. Each decision made on the owner's behalf, and why; each thing only the owner can do, such as trying real
CLIs, merging or releasing.>
