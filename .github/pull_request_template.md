## Summary

<!-- What does this change do, and why? -->

## Test plan

- [ ] `npm run check` passes locally (typecheck, lint, format check, tests)
- [ ] `npm run test:coverage` meets the 80% lines/branches threshold on `src/site/**` and `src/tools/**`
- [ ] If site markup/selectors changed: fixtures under `test/fixtures/` were re-recorded and diffed
- [ ] If this touches live-network behaviour: manually verified against `npm start` (see README "Local development")

## Notes for the reviewer

<!-- Anything that needs extra scrutiny: parser selector changes, cache/TTL behaviour, SSRF-relevant changes to get_course, CI/CD pipeline changes, etc. -->
