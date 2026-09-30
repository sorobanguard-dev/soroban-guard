# Description

<!-- Required: brief description of the changes in this PR. -->

## Related issue(s)

<!-- Required for a new check or feature: link the issue where the
     approach was agreed, e.g. Fixes #123 — a check is a claim about every
     token it runs against, and its spec clause is settled before the code.
     A typo fix or an obvious bug needs no issue first. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change)
- [ ] Documentation update
- [ ] Code refactoring
- [ ] Performance improvement
- [ ] Test update

## How it was verified

<!-- Required: the commands run and what they showed. For a change to the
     web checker, also what was clicked through in a browser with
     Freighter — the page script's DOM wiring has no unit tests, only
     the DOM-free modules it calls do. -->

## Checklist

- [ ] I have linked the related issue(s) above (required for a new check or feature)
- [ ] I have made corresponding changes to the documentation (if applicable)
- [ ] I have added tests, in the same commit as the logic, that prove my fix is effective or that my feature works
- [ ] Each new unit test fails when the behavior it names is removed (break the code once to check)
- [ ] `pnpm typecheck`, `pnpm check:ci` and `pnpm test` pass locally; `pnpm test:live` where applicable
- [ ] Every CodeRabbit comment is addressed, or answered with the reason it does not apply
