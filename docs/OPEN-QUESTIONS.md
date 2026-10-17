# Open Questions

## Resolved: Phase 3 worker test boundary

- Resolution: I-WRK-6 and I-WRK-8 move from `docs/TESTING.md` §5.3 to §5.4 and are required Phase 4 tests.
- Phase 3 keeps the `handleFailure` stub. Phase 4 must implement the dead-letter behavior and make both tests pass.

## Resolved: Phase 4 replay rate limiting

- No action - behavior is by design. Replay rate limiting is a v1 non-goal (D26).

