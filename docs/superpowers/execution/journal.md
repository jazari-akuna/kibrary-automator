# Execution Journal

Append-only log of plan execution. Manager (main Claude session) reads this at the start of every session and before every task to spot recurring patterns.

**Format per task:**
```
## Task N — <title>            <YYYY-MM-DD>
**Outcome:** ✓ pass / ✗ failed / ↑ escalated

### Loop 1
- Worker briefing: <key context given>
- Worker output: <one-line summary>
- QA verdict: <pass / fail with reason>
- Manager reasoning: <why we proceeded / how we framed any fix>

### Loop 2 (if any)
…

### Lessons
- <one-line takeaway>
```

**Escalation rules:**
- ≤3 fix iterations per task. After that = "mistake repeat detected."
- 1st escalation: dispatch a Candid agent (fresh, no journal context, just the problem statement).
- 2nd escalation: dispatch an Expert agent (specialist matched to the failure domain).
- Always journal both the symptom AND the resolution after escalation, so the pattern is recognizable next time.

---

<!-- Entries below this line, newest at the bottom. -->
